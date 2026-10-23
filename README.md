# Mesh-ResQ GNSS

Sistema de coordinación de rescate, mapeo táctico, reporte de bloqueos viales y
cálculo de rutas de evacuación para zonas de desastre **sin conectividad a
internet tradicional**, operando sobre una red Wi‑Fi mesh.

Implementado a partir de `instrucciones_de_desarrollo.md`.

---

## Componentes

```
[ Smartphone Rescatista A ] --- (Offline) ---> [ IndexedDB Local ]
           |
     (Wi-Fi Mesh / AP)
           |
           v
[ Nodo Raspberry Pi / Server ]
  ├── FastAPI (REST API + WebSockets)
  ├── PostGIS (Base de Datos Espacial)
  ├── Motor de Ruteo (NetworkX / Dijkstra)
  └── Static File Server (PWA + Dashboard)
           ^
           | (WebSocket / HTTP)
[ Estación de Control / Laptop Comandante ]
```

1. **Cliente de Campo (PWA)** — `app/static/cliente/`
   Captura GNSS continua (`watchPosition`, alta precisión), formulario rápido de
   bloqueos/riesgos/zonas peinadas, **selector del punto exacto del bloqueo
   sobre un mini-mapa Leaflet** (o GPS actual), cola offline en **IndexedDB** y
   sincronización automática por *heartbeat*.

2. **Estación de Control (Dashboard táctico)** — `app/static/control/`
   Mapa Leaflet a pantalla completa con capas de posiciones, zonas peinadas
   (verde), riesgos (naranja) y bloqueos (⚠️ rojo), más el trazado de la ruta
   óptima en azul neón que se **recalcula en vivo** al reportarse un bloqueo.

3. **Backend espacial** — `app/main.py`
   API REST + WebSocket, PostGIS vía SQLAlchemy/GeoAlchemy2 y motor de ruteo
   dinámico con NetworkX/Dijkstra.

---

## Inicio rápido

### Con Docker (PostgreSQL + PostGIS)

```bash
docker compose up --build
# Cliente de campo:  http://localhost:8000/cliente/
# Estación de control: http://localhost:8000/control/
# Documentación API:  http://localhost:8000/docs
```

### Local (sin PostGIS, ideal para desarrollo)

El backend detecta el motor: con SQLite guarda la geometría como GeoJSON; con
PostgreSQL usa PostGIS.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export DATABASE_URL="sqlite:///./mesh_resq.db"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Vistas de la aplicación

La misma API sirve dos frontends. Puedes cambiar entre ellos con el selector
que está arriba a la derecha (Control ⇄ Campo) o directamente por URL:

| Vista | URL | Para quién |
| ----- | --- | ---------- |
| **Estación de Control** | `http://localhost:8000/control/` | Comandantes / Protección Civil |
| **Cliente de Campo** | `http://localhost:8000/cliente/` | Rescatistas en terreno |

`http://localhost:8000/` redirige a la Estación de Control.

### Mapa y grafo de ruteo

El dashboard usa **OpenStreetMap en línea (estilo normal)** por defecto: no
necesita API key y las teselas se piden al espejo `tile.openstreetmap.de`. La
**retícula táctica local** se dibuja debajo como respaldo, así que si el nodo
pierde internet el mapa sigue operativo con las capas de rescatistas, riesgos y
bloqueos.

El escenario por defecto es **Puebla de Zaragoza, Puebla** (centro
`19.0433, -98.1987`). El **grafo de ruteo** (las calles que usa Dijkstra) es
local y ya está en `data/grafo.graphml`; para regenerarlo:

```bash
python scripts/descargar_mapa.py                 # Puebla, radio 4 km
python scripts/descargar_mapa.py --lat 19.0433 --lon -98.1987 --dist 6000
# -> data/grafo.graphml   (reinicia el backend para cargarlo)
```

No requiere `osmnx`: usa la API Overpass + NetworkX. Sin este archivo el motor
usa una **rejilla sintética** de respaldo centrada en Puebla.

**Escenario Acapulco (opcional).** El grafo de Acapulco se conserva en
`data/acapulco/grafo.graphml`:

```bash
export MESH_RESQ_GRAFO=./data/acapulco/grafo.graphml
python scripts/descargar_mapa.py --lat 16.868 --lon -99.894 \
    --salida data/acapulco/grafo.graphml
```

**Modo offline opcional.** Si necesitas el mapa sin internet, descarga las
teselas y activa el modo offline:

```bash
python scripts/descargar_teselas.py              # Puebla, 2.5 km, z13-17
# -> app/static/control/tiles/{z}/{x}/{y}.png
# en el entorno del backend:
export MESH_RESQ_TILES_MODO=offline
```

El modo offline carga muchas teselas locales y puede tardar más; el modo en
línea es el recomendado para el día a día. Las teselas de Acapulco, si se
descargan con `--salida app/static/control/tiles_acapulco`, se usan con
`MESH_RESQ_TILES_DIR`. Respeta la política de uso de la fuente de teselas
(áreas pequeñas, sin descargas masivas).

### Simulación de incidente (demo / verificación)

```bash
python scripts/simular_incidente.py --url http://localhost:8000
```

Genera telemetría, un riesgo, una zona peinada por buffer y comprueba que la
ruta cambia al registrar un bloqueo en medio del trayecto.

---

## Estructura del proyecto

```
.
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
├── pytest.ini
├── .env.example
├── app/
│   ├── __init__.py
│   ├── main.py             # API REST + WebSocket + estáticos
│   ├── database.py         # Modelos espaciales (PostGIS/SQLAlchemy)
│   ├── schemas.py          # Esquemas Pydantic
│   ├── spatial_utils.py    # Geodesia, buffers, punto-en-polígono
│   ├── routing_engine.py   # Grafo (OSMnx/NetworkX) + Dijkstra dinámico
│   └── static/
│       ├── cliente/        # PWA del rescatista
│       │   ├── index.html
│       │   ├── app.js
│       │   ├── sw.js
│       │   ├── manifest.json
│       │   └── icon.svg
│       └── control/        # Dashboard de mando
│           ├── index.html
│           ├── dashboard.js
│           └── vendor/     # Leaflet local (sin CDN ni API keys)
├── data/                   # grafo.graphml (Puebla, por defecto) + acapulco/
├── scripts/
│   ├── descargar_mapa.py   # Red vial OSM -> data/grafo.graphml (Puebla)
│   ├── descargar_teselas.py # Teselas offline -> app/static/control/tiles
│   └── simular_incidente.py
└── tests/                  # pytest (API, ruteo, utilidades espaciales)
```

---

## API

| Método | Ruta | Descripción |
| ------ | ---- | ----------- |
| `POST` | `/api/telemetria/batch` | Lote de puntos GNSS acumulados offline. |
| `POST` | `/api/riesgos/` | Amenaza puntual con radio de afectación. |
| `POST` | `/api/zonas-peinadas/` | Polígono peinado manual o por *buffer* de recorrido. |
| `POST` | `/api/bloqueos/` | Bloqueo vial; actualiza el grafo de ruteo. |
| `PATCH` | `/api/bloqueos/{id}` | Activa/libera un bloqueo (recalcula el grafo). |
| `GET` | `/api/ruteo/optimo` | Ruta más rápida esquivando bloqueos activos. |
| `GET` | `/api/control/estado-global` | Todas las capas activas en **GeoJSON**. |
| `GET` | `/api/config` · `/health` | Parámetros de arranque y estado del motor. |
| `WS` | `/ws/control` | Posiciones, bloqueos y alertas en vivo. |

Ejemplo de ruteo:

```bash
curl "http://localhost:8000/api/ruteo/optimo?\
origen_lat=19.04&origen_lon=-98.20&destino_lat=19.05&destino_lon=-98.19"
```

---

## Modelo de datos (`app/database.py`)

`PosicionRescatista`, `ZonaPeinada`, `ReporteRiesgo` y `BloqueoVial` usan
columnas `Geometry('POINT'|'POLYGON', srid=4326)`. La clase `Geometry` es un
`TypeDecorator` que:

* en **PostgreSQL** delega en `geoalchemy2.Geometry` (tipo nativo + índice GiST);
* en cualquier otro motor guarda el GeoJSON serializado en texto.

A nivel de aplicación las geometrías siempre son diccionarios **GeoJSON**.

---

## Motor de ruteo (`app/routing_engine.py`)

* Carga `data/grafo.graphml` (OSM/Overpass) o genera una rejilla sintética.
* `bloquear_nodo_o_arista(lat, lon, radio)`: **asigna peso `+inf`** a toda
  arista (y nodo) dentro del radio del bloqueo.
* `calcular_ruta_optima(...)`: Dijkstra sobre el grafo ajustado en tiempo real;
  lanza `RutaNoEncontrada` si no hay camino viable.

---

## Pruebas

```bash
python -m pytest
```

Cubren, entre otros, los **criterios de aceptación**:

1. **Simulación offline** — el cliente guarda en IndexedDB sin conexión (lógica
   en `app/static/cliente/app.js`); el backend valida lotes con timestamps
   originales.
2. **Sincronización** — `POST /api/telemetria/batch` conserva los *timestamps*
   enviados desde el campo.
3. **Re‑enrutamiento en tiempo real** — `test_re_enrutamiento_esquiva_bloqueo`
   traza una ruta, bloquea un tramo intermedio y verifica que la ruta cambia y
   se restaura al liberar el bloqueo.

---

## Notas sobre el mapa

* Por defecto el dashboard usa **OpenStreetMap en línea** (estilo normal,
  teselas de `tile.openstreetmap.de`, atribución a OSM) centrado en **Puebla**.
  **No requiere API key** y no hay peticiones a servicios con clave.
* La **retícula táctica en canvas** se dibuja siempre debajo: si no hay
  internet, el mapa base sigue visible y las capas operativas no se pierden.
* El **grafo de ruteo** es local (`data/grafo.graphml`, Puebla) y no depende de
  las teselas. El escenario Acapulco se conserva en
  `data/acapulco/grafo.graphml` y se activa con `MESH_RESQ_GRAFO`.
* Para el modo offline de teselas, usa `MESH_RESQ_TILES_MODO=offline`
  (ver arriba).
* Para otra zona o un *tile server* propio:
  ```bash
  export MESH_RESQ_TILES_URL="http://tu-servidor/tiles/{z}/{x}/{y}.png"
  export MESH_RESQ_TILES_ATRIBUCION="© Tu proveedor"
  ```
* Variables de entorno disponibles en `.env.example`
  (`DATABASE_URL`, `MESH_RESQ_GRAFO`, `MESH_RESQ_CENTRO_LAT/LON`,
  `MESH_RESQ_TILES_MODO`, `MESH_RESQ_TILES_URL`, `MESH_RESQ_TILES_DIR`,
  `MESH_RESQ_TILES_OSCURECER`, …).
