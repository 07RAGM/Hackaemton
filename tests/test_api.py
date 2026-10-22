"""Pruebas de integración de la API y de los criterios de aceptación tácticos."""

from __future__ import annotations

import math

from app.spatial_utils import destino


def _punto(centro: dict, rumbo: float, metros: float):
    lat, lon = destino(centro["lat"], centro["lon"], rumbo, metros)
    return lat, lon


# --------------------------------------------------------------------------- #
# Salud y configuración
# --------------------------------------------------------------------------- #
def test_health(cliente):
    datos = cliente.get("/health").json()
    assert datos["status"] == "ok"
    assert datos["motor_ruteo"]["nodos"] > 0


def test_config(cliente):
    cfg = cliente.get("/api/config").json()
    assert "centro" in cfg
    assert "ESCOMBROS" in cfg["tipos_obstaculo"]


# --------------------------------------------------------------------------- #
# 1. Telemetría por lotes (con timestamps originales del cliente offline)
# --------------------------------------------------------------------------- #
def test_telemetria_batch(cliente, centro):
    puntos = [
        {
            "lat": centro["lat"] + i * 0.0001,
            "lon": centro["lon"] + i * 0.0001,
            "altitud": 2100 + i,
            "precision_m": 5.0 + i,
            "timestamp": f"2026-01-0{i + 1}T10:00:00+00:00",
        }
        for i in range(5)
    ]
    resp = cliente.post(
        "/api/telemetria/batch",
        json={"rescatista_id": "R-TEST", "cuadrilla": "ALFA", "puntos": puntos},
    )
    assert resp.status_code == 200
    assert resp.json()["insertados"] == 5

    estado = cliente.get("/api/control/estado-global").json()
    posiciones = [f for f in estado["features"] if f["properties"]["capa"] == "posiciones"]
    assert len(posiciones) == 5
    assert posiciones[0]["properties"]["precision_m"] == 5.0
    # La marca de tiempo original debe conservarse.
    assert posiciones[0]["properties"]["timestamp"].startswith("2026-01-01")


def test_telemetria_lote_vacio_rechazado(cliente):
    resp = cliente.post(
        "/api/telemetria/batch",
        json={"rescatista_id": "R", "puntos": []},
    )
    assert resp.status_code == 422


# --------------------------------------------------------------------------- #
# 2. Riesgos y zonas peinadas
# --------------------------------------------------------------------------- #
def test_riesgo(cliente, centro):
    resp = cliente.post(
        "/api/riesgos/",
        json={
            "tipo_riesgo": "fuga de gas",
            "nivel_gravedad": 5,
            "lat": centro["lat"],
            "lon": centro["lon"],
            "radio_afectacion_m": 40,
            "descripcion": "Fuga en válvula",
        },
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["properties"]["tipo_riesgo"] == "FUGA_DE_GAS"  # normalización
    assert data["properties"]["poligono_afectacion"]["type"] == "Polygon"


def test_zona_peinada_por_buffer(cliente, centro):
    recorrido = [list(reversed(_punto(centro, 0, i * 25))) for i in range(6)]  # [lon, lat]
    resp = cliente.post(
        "/api/zonas-peinadas/",
        json={"cuadrilla_id": "ALFA", "recorrido": recorrido, "radio_m": 30},
    )
    assert resp.status_code == 200
    geom = resp.json()["data"]["geometry"]
    assert geom["type"] == "Polygon"
    assert len(geom["coordinates"][0]) >= 4


def test_zona_peinada_sin_datos(cliente):
    resp = cliente.post("/api/zonas-peinadas/", json={"cuadrilla_id": "ALFA"})
    assert resp.status_code == 422


# --------------------------------------------------------------------------- #
# 3. Re-enrutamiento en tiempo real (criterio de aceptación principal)
# --------------------------------------------------------------------------- #
def test_re_enrutamiento_esquiva_bloqueo(cliente, centro):
    o_lat, o_lon = _punto(centro, 180, 350)
    d_lat, d_lon = _punto(centro, 0, 350)
    params = {
        "origen_lat": o_lat,
        "origen_lon": o_lon,
        "destino_lat": d_lat,
        "destino_lon": d_lon,
    }

    antes = cliente.get("/api/ruteo/optimo", params=params).json()
    assert antes["distancia_m"] > 0
    assert antes["bloqueos_esquivados"] == 0

    # Bloqueo justo en el punto medio del trayecto original.
    medio = antes["coordenadas"][len(antes["coordenadas"]) // 2]
    resp = cliente.post(
        "/api/bloqueos/",
        json={
            "tipo_obstaculo": "ESCOMBROS",
            "lat": medio[1],
            "lon": medio[0],
            "radio_bloqueo_m": 90,
            "descripcion": "Vía cerrada",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["grafo"]["bloqueos_activos"] == 1
    id_bloqueo = resp.json()["id"]

    despues = cliente.get("/api/ruteo/optimo", params=params).json()
    assert despues["bloqueos_esquivados"] == 1
    # La ruta debe cambiar (rodeo) y seguir siendo finita.
    assert math.isfinite(despues["distancia_m"])
    assert despues["coordenadas"] != antes["coordenadas"]
    assert despues["distancia_m"] >= antes["distancia_m"] - 1e-6

    # Al liberar el bloqueo el grafo vuelve a estar limpio.
    cliente.patch(f"/api/bloqueos/{id_bloqueo}", json={"activo": False})
    final = cliente.get("/api/ruteo/optimo", params=params).json()
    assert final["bloqueos_esquivados"] == 0
    assert final["coordenadas"] == antes["coordenadas"]


def test_estado_global_es_geojson(cliente, centro):
    cliente.post(
        "/api/bloqueos/",
        json={"tipo_obstaculo": "ARBOL_CAIDO", "lat": centro["lat"], "lon": centro["lon"]},
    )
    fc = cliente.get("/api/control/estado-global").json()
    assert fc["type"] == "FeatureCollection"
    assert fc["metadata"]["conteos"]["bloqueos"] == 1
    assert all(f["type"] == "Feature" for f in fc["features"])


# --------------------------------------------------------------------------- #
# 4. WebSocket de control
# --------------------------------------------------------------------------- #
def test_websocket_snapshot(cliente):
    with cliente.websocket_connect("/ws/control") as ws:
        mensaje = ws.receive_json()
        assert mensaje["tipo"] == "snapshot"
        assert mensaje["data"]["type"] == "FeatureCollection"
        ws.send_text("ping")
        assert ws.receive_json()["tipo"] == "pong"


# --------------------------------------------------------------------------- #
# 5. Estáticos (PWA + dashboard)
# --------------------------------------------------------------------------- #
def test_estaticos(cliente):
    assert cliente.get("/control/").status_code == 200
    assert cliente.get("/cliente/").status_code == 200
    assert cliente.get("/manifest.json").status_code == 200
    assert cliente.get("/sw.js").status_code == 200
