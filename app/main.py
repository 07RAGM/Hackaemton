"""Mesh-ResQ GNSS — API FastAPI, WebSocket en vivo y servidor de estáticos.

Endpoints principales (sección 4 de la especificación):

* ``POST   /api/telemetria/batch``      lote de puntos GNSS offline
* ``POST   /api/riesgos/``              amenaza puntual con radio
* ``POST   /api/zonas-peinadas/``       polígono peinado (manual o buffer)
* ``POST   /api/bloqueos/``             bloqueo vial (actualiza el grafo)
* ``GET    /api/ruteo/optimo``          ruta más rápida esquivando bloqueos
* ``GET    /api/control/estado-global`` capas activas en GeoJSON
* ``WS     /ws/control``                difusión en vivo a la Estación de Control
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import List, Optional, Set

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import __version__
from .database import (
    BloqueoVial,
    PosicionRescatista,
    ReporteRiesgo,
    ZonaPeinada,
    get_db,
    init_db,
    utcnow,
)
from .routing_engine import RutaNoEncontrada, obtener_motor
from .schemas import (
    BloqueoEstadoIn,
    BloqueoVialIn,
    ReporteRiesgoIn,
    TelemetriaBatch,
    ZonaPeinadaIn,
)
from .spatial_utils import buffer_recorrido, circulo_poligono

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mesh-resq")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
TILES_ACAPULCO_DIR = os.path.join(STATIC_DIR, "control", "tiles_acapulco")
# Directorio de teselas offline de Acapulco. Las teselas de otro escenario
# (p. ej. Puebla) quedan intactas en static/control/tiles/ y se pueden usar
# con MESH_RESQ_TILES_DIR o MESH_RESQ_TILES_URL.
TILES_DIR = os.getenv("MESH_RESQ_TILES_DIR") or TILES_ACAPULCO_DIR
TILES_URL = f"/control/{os.path.basename(TILES_DIR)}/{{z}}/{{x}}/{{y}}.png"

# Mapa en línea por defecto: OSM estándar (estilo normal, sin API key). El
# servidor .de es el espejo de OSM que sí sirve teselas a este nodo; el
# principal (tile.openstreetmap.org) bloquea descargas automatizadas.
OSM_TILES_URL = os.getenv(
    "MESH_RESQ_TILES_ONLINE", "https://tile.openstreetmap.de/{z}/{x}/{y}.png"
)


def _teselas_locales() -> Optional[dict]:
    """Detecta teselas descargadas en el directorio de teselas activo.

    Si existen, el dashboard las usa por defecto sin configurar variables de
    entorno (mapa real offline de Acapulco).
    """

    if not os.path.isdir(TILES_DIR):
        return None
    zooms = []
    try:
        for nombre in os.listdir(TILES_DIR):
            ruta = os.path.join(TILES_DIR, nombre)
            if nombre.isdigit() and os.path.isdir(ruta):
                zooms.append(int(nombre))
    except OSError:  # pragma: no cover - permisos
        return None

    meta = {}
    meta_path = os.path.join(TILES_DIR, "meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as fh:
                meta = json.load(fh)
        except (OSError, ValueError):  # pragma: no cover - metadatos corruptos
            meta = {}

    if not zooms and not meta:
        return None
    bbox = meta.get("bbox")
    return {
        "url": TILES_URL,
        "min_zoom": meta.get("zoom_min", min(zooms) if zooms else None),
        "max_zoom": meta.get("zoom_max", max(zooms) if zooms else None),
        "bounds": bbox if isinstance(bbox, list) and len(bbox) == 4 else None,
    }


@asynccontextmanager
async def ciclo_vida(app: FastAPI):
    _arranque()
    yield


app = FastAPI(
    title="Mesh-ResQ GNSS",
    description="Coordinación de rescate, mapeo táctico y ruteo de evacuación sin internet.",
    version=__version__,
    lifespan=ciclo_vida,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Gestor de conexiones WebSocket
# --------------------------------------------------------------------------- #
class GestorConexiones:
    """Conjunto de clientes WebSocket conectados a la Estación de Control."""

    def __init__(self) -> None:
        self.activas: Set[WebSocket] = set()

    async def conectar(self, ws: WebSocket) -> None:
        await ws.accept()
        self.activas.add(ws)
        log.info("WS conectado (%d clientes)", len(self.activas))

    def desconectar(self, ws: WebSocket) -> None:
        self.activas.discard(ws)
        log.info("WS desconectado (%d clientes)", len(self.activas))

    async def difundir(self, mensaje: dict) -> None:
        for ws in list(self.activas):
            try:
                await ws.send_json(mensaje)
            except Exception:
                self.desconectar(ws)


gestor = GestorConexiones()


# --------------------------------------------------------------------------- #
# Ciclo de vida
# --------------------------------------------------------------------------- #
def _arranque() -> None:
    init_db()
    motor = obtener_motor()
    # Rehidrata el grafo con los bloqueos activos persistidos en la BD.
    from .database import SessionLocal

    with SessionLocal() as db:
        activos = db.scalars(
            select(BloqueoVial).where(BloqueoVial.activo.is_(True))
        ).all()
        motor.limpiar_bloqueos()
        for b in activos:
            geo = b.ubicacion or {}
            coords = geo.get("coordinates")
            if coords:
                motor.bloquear_nodo_o_arista(
                    coords[1], coords[0], b.radio_bloqueo_m, identificador=str(b.id)
                )
    log.info("Motor de ruteo listo: %s", motor.estado())


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def _punto_geojson(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [lon, lat]}


def _a_naive_utc(dt):
    """Normaliza a UTC aware para almacenar timestamps de clientes offline."""

    if dt is None:
        return utcnow()
    from datetime import timezone

    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# --------------------------------------------------------------------------- #
# 1. Telemetría GNSS (batch)
# --------------------------------------------------------------------------- #
@app.post("/api/telemetria/batch")
async def telemetria_batch(lote: TelemetriaBatch, db: Session = Depends(get_db)):
    """Recibe un arreglo de puntos GNSS acumulados offline por el rescatista."""

    creados: List[PosicionRescatista] = []
    for p in lote.puntos:
        pos = PosicionRescatista(
            rescatista_id=p.rescatista_id or lote.rescatista_id,
            cuadrilla=p.cuadrilla or lote.cuadrilla,
            ubicacion=_punto_geojson(p.lon, p.lat),
            altitud=p.altitud,
            precision_m=p.precision_m,
            timestamp=_a_naive_utc(p.timestamp),
        )
        db.add(pos)
        creados.append(pos)
    db.commit()

    ultimo = creados[-1]
    await gestor.difundir(
        {
            "tipo": "telemetria_batch",
            "cantidad": len(creados),
            "data": ultimo.a_geojson(),
        }
    )
    return {"ok": True, "insertados": len(creados)}


# --------------------------------------------------------------------------- #
# 2. Riesgos
# --------------------------------------------------------------------------- #
@app.post("/api/riesgos/")
async def crear_riesgo(riesgo: ReporteRiesgoIn, db: Session = Depends(get_db)):
    fila = ReporteRiesgo(
        tipo_riesgo=riesgo.tipo_riesgo,
        nivel_gravedad=riesgo.nivel_gravedad,
        ubicacion=_punto_geojson(riesgo.lon, riesgo.lat),
        radio_afectacion_m=riesgo.radio_afectacion_m,
        descripcion=riesgo.descripcion,
        timestamp=_a_naive_utc(riesgo.timestamp),
    )
    db.add(fila)
    db.commit()
    db.refresh(fila)

    feature = fila.a_geojson()
    feature["properties"]["poligono_afectacion"] = circulo_poligono(
        riesgo.lat, riesgo.lon, riesgo.radio_afectacion_m
    )
    await gestor.difundir({"tipo": "riesgo", "data": feature})
    return {"ok": True, "id": fila.id, "data": feature}


@app.get("/api/riesgos/")
def listar_riesgos(
    solo_pendientes: bool = False,
    db: Session = Depends(get_db),
):
    q = select(ReporteRiesgo)
    if solo_pendientes:
        q = q.where(ReporteRiesgo.atendido.is_(False))
    filas = db.scalars(q.order_by(ReporteRiesgo.timestamp.desc())).all()
    return [f.a_geojson() for f in filas]


# --------------------------------------------------------------------------- #
# 3. Zonas peinadas
# --------------------------------------------------------------------------- #
@app.post("/api/zonas-peinadas/")
async def crear_zona_peinada(zona: ZonaPeinadaIn, db: Session = Depends(get_db)):
    """Registra un polígono peinado (manual) o lo calcula vía buffer continuo."""

    if zona.poligono:
        poligono = zona.poligono
    elif zona.recorrido:
        if len(zona.recorrido) < 1:
            raise HTTPException(422, "El recorrido debe contener al menos un punto")
        try:
            poligono = buffer_recorrido(zona.recorrido, zona.radio_m)
        except Exception as exc:  # pragma: no cover - entrada inválida
            raise HTTPException(422, f"No se pudo calcular el buffer: {exc}") from exc
    else:
        raise HTTPException(422, "Debe enviar 'poligono' o 'recorrido'")

    fila = ZonaPeinada(
        cuadrilla_id=zona.cuadrilla_id,
        poligono=poligono,
        observaciones=zona.observaciones,
        timestamp=_a_naive_utc(zona.timestamp),
    )
    db.add(fila)
    db.commit()
    db.refresh(fila)

    feature = fila.a_geojson()
    await gestor.difundir({"tipo": "zona_peinada", "data": feature})
    return {"ok": True, "id": fila.id, "data": feature}


@app.get("/api/zonas-peinadas/")
def listar_zonas(db: Session = Depends(get_db)):
    filas = db.scalars(select(ZonaPeinada).order_by(ZonaPeinada.timestamp.desc())).all()
    return [f.a_geojson() for f in filas]


# --------------------------------------------------------------------------- #
# 4. Bloqueos viales
# --------------------------------------------------------------------------- #
@app.post("/api/bloqueos/")
async def crear_bloqueo(bloqueo: BloqueoVialIn, db: Session = Depends(get_db)):
    """Registra un bloqueo vial y actualiza el grafo de ruteo en tiempo real."""

    fila = BloqueoVial(
        tipo_obstaculo=bloqueo.tipo_obstaculo,
        ubicacion=_punto_geojson(bloqueo.lon, bloqueo.lat),
        radio_bloqueo_m=bloqueo.radio_bloqueo_m,
        descripcion=bloqueo.descripcion,
        activo=True,
        timestamp=_a_naive_utc(bloqueo.timestamp),
    )
    db.add(fila)
    db.commit()
    db.refresh(fila)

    motor = obtener_motor()
    motor.bloquear_nodo_o_arista(
        bloqueo.lat, bloqueo.lon, bloqueo.radio_bloqueo_m, identificador=str(fila.id)
    )

    feature = fila.a_geojson()
    feature["properties"]["poligono_afectacion"] = circulo_poligono(
        bloqueo.lat, bloqueo.lon, bloqueo.radio_bloqueo_m
    )
    feature["properties"]["grafo_version"] = motor.estado()["version"]
    await gestor.difundir({"tipo": "bloqueo", "data": feature})
    return {"ok": True, "id": fila.id, "data": feature, "grafo": motor.estado()}


@app.get("/api/bloqueos/")
def listar_bloqueos(
    solo_activos: bool = True,
    db: Session = Depends(get_db),
):
    q = select(BloqueoVial)
    if solo_activos:
        q = q.where(BloqueoVial.activo.is_(True))
    filas = db.scalars(q.order_by(BloqueoVial.timestamp.desc())).all()
    return [f.a_geojson() for f in filas]


@app.patch("/api/bloqueos/{bloqueo_id}")
async def actualizar_bloqueo(
    bloqueo_id: int,
    estado: BloqueoEstadoIn,
    db: Session = Depends(get_db),
):
    """Activa/desactiva un bloqueo (al liberarlo el grafo deja de esquivarlo)."""

    fila = db.get(BloqueoVial, bloqueo_id)
    if fila is None:
        raise HTTPException(404, "Bloqueo no encontrado")
    fila.activo = estado.activo
    db.commit()
    db.refresh(fila)

    motor = obtener_motor()
    if estado.activo:
        geo = fila.ubicacion or {}
        coords = geo.get("coordinates", [None, None])
        motor.bloquear_nodo_o_arista(
            coords[1], coords[0], fila.radio_bloqueo_m, identificador=str(fila.id)
        )
    else:
        motor.liberar_bloqueo(str(fila.id))

    feature = fila.a_geojson()
    await gestor.difundir({"tipo": "bloqueo_actualizado", "data": feature})
    return {"ok": True, "id": fila.id, "data": feature}


# --------------------------------------------------------------------------- #
# 5. Ruteo óptimo
# --------------------------------------------------------------------------- #
@app.get("/api/ruteo/optimo")
def ruteo_optimo(
    origen_lat: float = Query(..., ge=-90, le=90),
    origen_lon: float = Query(..., ge=-180, le=180),
    destino_lat: float = Query(..., ge=-90, le=90),
    destino_lon: float = Query(..., ge=-180, le=180),
    velocidad_m_s: Optional[float] = Query(None, gt=0),
):
    """Ruta más rápida entre dos puntos esquivando los bloqueos activos."""

    motor = obtener_motor()
    try:
        resultado = motor.calcular_ruta_optima(
            origen_lat,
            origen_lon,
            destino_lat,
            destino_lon,
            velocidad_m_s=velocidad_m_s,
        )
    except RutaNoEncontrada as exc:
        raise HTTPException(422, str(exc)) from exc

    resultado["bloqueos_esquivados"] = motor.estado()["bloqueos_activos"]
    return resultado


# --------------------------------------------------------------------------- #
# 6. Estado global (GeoJSON)
# --------------------------------------------------------------------------- #
@app.get("/api/control/estado-global")
def estado_global(
    segundos_posiciones: int = Query(0, ge=0, description="0 = todas"),
    db: Session = Depends(get_db),
):
    """Todas las capas activas en un único ``FeatureCollection`` GeoJSON."""

    q_pos = select(PosicionRescatista)
    if segundos_posiciones > 0:
        from datetime import timedelta

        limite = utcnow() - timedelta(seconds=segundos_posiciones)
        q_pos = q_pos.where(PosicionRescatista.timestamp >= limite)

    posiciones = db.scalars(q_pos.order_by(PosicionRescatista.timestamp.asc())).all()
    zonas = db.scalars(select(ZonaPeinada)).all()
    riesgos = db.scalars(select(ReporteRiesgo)).all()
    bloqueos = db.scalars(
        select(BloqueoVial).where(BloqueoVial.activo.is_(True))
    ).all()

    features = [f.a_geojson() for f in posiciones]
    features += [f.a_geojson() for f in zonas]
    features += [f.a_geojson() for f in riesgos]
    features += [f.a_geojson() for f in bloqueos]

    motor = obtener_motor()
    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "generado": utcnow().isoformat(),
            "conteos": {
                "posiciones": len(posiciones),
                "zonas_peinadas": len(zonas),
                "riesgos": len(riesgos),
                "bloqueos": len(bloqueos),
            },
            "motor_ruteo": motor.estado(),
        },
    }


@app.get("/api/config")
def configuracion():
    """Parámetros de arranque para los clientes (centro del mapa, versión, etc.)."""

    motor = obtener_motor()
    lat, lon = motor.centro()

    # Prioridad: MESH_RESQ_TILES_URL > MESH_RESQ_TILES_MODO > OSM en línea.
    # Por defecto el dashboard usa OpenStreetMap en línea (estilo normal, sin
    # API key); el modo offline con teselas descargadas es opt-in.
    modo = os.getenv("MESH_RESQ_TILES_MODO", "online").strip().lower()
    locales = _teselas_locales()
    tiles_url_env = os.getenv("MESH_RESQ_TILES_URL")
    if tiles_url_env:
        tiles_url = tiles_url_env
    elif modo == "offline":
        tiles_url = locales["url"] if locales else None
    else:
        tiles_url = OSM_TILES_URL
    es_local = bool(locales and tiles_url == locales["url"])

    atribucion = os.getenv("MESH_RESQ_TILES_ATRIBUCION")
    if not atribucion:
        if tiles_url is None:
            atribucion = "Fondo táctico local"
        elif es_local or "openstreetmap" in tiles_url.lower():
            atribucion = "© OpenStreetMap contributors"
        else:
            atribucion = "Uso interno · verificar licencia del proveedor"

    return {
        "version": __version__,
        "centro": {"lat": lat, "lon": lon},
        "velocidad_m_s": motor.velocidad_m_s,
        "fuente_grafo": motor.estado()["fuente"],
        "tiles_url": tiles_url,
        "tiles_atribucion": atribucion,
        "tiles_local": es_local,
        "tiles_min_zoom": locales["min_zoom"] if es_local else None,
        "tiles_max_zoom": locales["max_zoom"] if es_local else (19 if tiles_url else None),
        "tiles_bounds": locales["bounds"] if es_local else None,
        # Por defecto se muestra el estilo normal de OSM (sin filtro oscuro).
        # Con MESH_RESQ_TILES_OSCURECER=1 se invierte para un tema oscuro.
        "tiles_oscuras": os.getenv("MESH_RESQ_TILES_OSCURECER", "0").lower()
        not in ("0", "false", "no", ""),
        "tipos_obstaculo": list(
            ("ESCOMBROS", "ARBOL_CAIDO", "DERRUMBE", "INUNDACION", "OTRO")
        ),
        "tipos_riesgo": list(
            ("COLAPSO", "FUGA_GAS", "INCENDIO", "QUIMICO", "ELECTRICO", "INUNDACION", "OTRO")
        ),
    }


@app.get("/health")
def health():
    motor = obtener_motor()
    return {"status": "ok", "version": __version__, "motor_ruteo": motor.estado()}


# --------------------------------------------------------------------------- #
# 7. WebSocket en vivo
# --------------------------------------------------------------------------- #
@app.websocket("/ws/control")
async def ws_control(ws: WebSocket):
    await gestor.conectar(ws)
    try:
        # Snapshot inicial para que el dashboard pinte de inmediato.
        from .database import SessionLocal

        with SessionLocal() as db:
            snapshot = estado_global(segundos_posiciones=0, db=db)
        await ws.send_json({"tipo": "snapshot", "data": snapshot})
        while True:
            mensaje = await ws.receive_text()
            if mensaje == "ping":
                await ws.send_json({"tipo": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover
        log.warning("WS error: %s", exc)
    finally:
        gestor.desconectar(ws)


# --------------------------------------------------------------------------- #
# Estáticos: PWA del rescatista + Dashboard de control
# --------------------------------------------------------------------------- #
app.mount(
    "/cliente",
    StaticFiles(directory=os.path.join(STATIC_DIR, "cliente"), html=True),
    name="cliente",
)
app.mount(
    "/control",
    StaticFiles(directory=os.path.join(STATIC_DIR, "control"), html=True),
    name="control",
)


@app.get("/", include_in_schema=False)
def raiz():
    return RedirectResponse(url="/control/")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    """Sirve el service worker del cliente en la raíz para ampliar su scope PWA."""

    return FileResponse(os.path.join(STATIC_DIR, "cliente", "sw.js"), media_type="application/javascript")


@app.get("/manifest.json", include_in_schema=False)
def manifest():
    return FileResponse(
        os.path.join(STATIC_DIR, "cliente", "manifest.json"),
        media_type="application/manifest+json",
    )


@app.exception_handler(ValueError)
async def _value_error_handler(_request, exc: ValueError):  # pragma: no cover
    return JSONResponse(status_code=422, content={"ok": False, "detail": str(exc)})
