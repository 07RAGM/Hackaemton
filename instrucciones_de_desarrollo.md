# ESPECIFICACIÓN TÉCNICA Y PROMPT DE DESARROLLO: MESH-RESQ GNSS

> **Propósito:** Documento de instrucciones arquitectónicas y código base para la generación automatizada del sistema **Mesh-ResQ GNSS**. Este sistema está diseñado para la coordinación de rescate, mapeo táctico, reporte de bloqueos viales y cálculo de rutas de evacuación en zonas de desastre sin conectividad a internet tradicional.

---

## 1. RESUMEN EJECUTIVO Y VISUALIZACIÓN DEL SISTEMA

El sistema se compone de dos interfaces principales conectadas a un backend unificado con motor espacial y de grafos (FastAPI + PostGIS + NetworkX/OSMnx):

1. **Cliente de Campo (PWA Móvil para Rescatistas):**
   * Interfaz ultra-minimalista de alto contraste (*Dark Mode* táctico).
   * Captura continua de telemetría GNSS (latitud, longitud, altitud, precisión).
   * Formulario rápido de reporte de zonas peinadas, hallazgos de víctimas, riesgos (fugas, incendios) y **bloqueos viales (escombros, árboles caídos, colapsos de puentes)**.
   * Cola de almacenamiento local (`IndexedDB`) con sincronización automática mediante *Heartbeat* cuando se conecta al nodo mesh.

2. **Estación de Control (Dashboard Táctico para Comandantes/Protección Civil):**
   * Mapa geoespacial interactivo full-screen (Leaflet / Mapbox GL).
   * **Capa Verde:** Polígonos de zonas peinadas/revisadas (`ST_Buffer` sobre trazado de rescatistas) para evitar duplicación de esfuerzos.
   * **Capa Roja/Naranja:** Geocercas de peligro activo y marcadores de **bloqueos viales con radio de afectación**.
   * **Capa Azul/Marcadores:** Posición en tiempo real de cuadrillas de rescatistas y vehículos de emergencia.
   * **Motor de Ruteo Dinámico Táctico:** Trazado automático de la ruta más rápida entre dos puntos (ej. Ambulancia -> Hospital) modificando el grafo vial en tiempo real para esquivar las calles reportadas como bloqueadas.

---

## 2. ARQUITECTURA TÉCNICA

```
[ Smartphone Rescatista A ] --- (Offline) ---> [ IndexedDB Local ]
           |
     (Wi-Fi Mesh / AP)
           |
           v
[ Nodo Raspberry Pi / Server ]
  ├── FastAPI (REST API + WebSockets)
  ├── PostGIS (Base de Datos Espacial)
  ├── Motor de Ruteo (OSMnx / NetworkX / Dijkstra)
  └── Static File Server (PWA + Control Station Dashboard)
           ^
           | (WebSocket / HTTP)
[ Estación de Control / Laptop Comandante ]
```

---

## 3. ESQUEMA DE BASE DE DATOS (PostGIS / SQLAlchemy)

Crea los modelos de datos en `database.py` asegurando el uso de tipos espaciales (`Geometry`):

```python
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean, create_engine
from sqlalchemy.orm import declarative_base
from geoalchemy2 import Geometry
from datetime import datetime

Base = declarative_base()

class PosicionRescatista(Base):
    __tablename__ = "posiciones_rescatistas"
    
    id = Column(Integer, primary_key=True, index=True)
    rescatista_id = Column(String, index=True)
    cuadrilla = Column(String, index=True)
    ubicacion = Column(Geometry('POINT', srid=4326))
    altitud = Column(Float, nullable=True)
    precision_m = Column(Float)
    timestamp = Column(DateTime, default=datetime.utcnow)

class ZonaPeinada(Base):
    __tablename__ = "zonas_peinadas"
    
    id = Column(Integer, primary_key=True, index=True)
    cuadrilla_id = Column(String)
    poligono = Column(Geometry('POLYGON', srid=4326))
    observaciones = Column(Text, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)

class ReporteRiesgo(Base):
    __tablename__ = "reportes_riesgo"
    
    id = Column(Integer, primary_key=True, index=True)
    tipo_riesgo = Column(String)  # ej: Colapso, Fuga de Gas, Incendio
    nivel_gravedad = Column(Integer)  # 1 (Bajo) a 5 (Crítico)
    ubicacion = Column(Geometry('POINT', srid=4326))
    radio_afectacion_m = Column(Float, default=10.0)
    descripcion = Column(Text)
    atendido = Column(Boolean, default=False)
    timestamp = Column(DateTime, default=datetime.utcnow)

class BloqueoVial(Base):
    __tablename__ = "bloqueos_viales"
    
    id = Column(Integer, primary_key=True, index=True)
    tipo_obstaculo = Column(String)  # ESCOMBROS, ARBOL_CAIDO, DERRUMBE, INUNDACION
    ubicacion = Column(Geometry('POINT', srid=4326))
    radio_bloqueo_m = Column(Float, default=15.0)
    descripcion = Column(Text)
    activo = Column(Boolean, default=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
```

---

## 4. ENDPOINTS API (FastAPI `main.py`)

Deben implementarse las siguientes rutas principales:

1. `POST /api/telemetria/batch`: Recibe un arreglo de puntos GNSS acumulados offline por el rescatista.
2. `POST /api/riesgos/`: Registra una nueva amenaza puntual con su radio de afectación.
3. `POST /api/zonas-peinadas/`: Registra un polígono peinado manualmente o calculado vía buffer continuo.
4. `POST /api/bloqueos/`: Registra una calle o intersección bloqueada y notifica la actualización del grafo.
5. `GET /api/ruteo/optimo`: Recibe `origen_lat`, `origen_lon`, `destino_lat`, `destino_lon` y retorna las coordenadas de la ruta calculada evitando los bloqueos activos.
6. `GET /api/control/estado-global`: Retorna en formato **GeoJSON** todas las capas activas (posiciones, polígonos peinados, riesgos y bloqueos viales).
7. `WS /ws/control`: WebSocket para transmitir posiciones, bloqueos y alertas en vivo a la Estación de Control.

---

## 5. ESTRUCTURA DEL PROYECTO

Organiza la solución en una estructura monolítica limpia para despliegue rápido:

```
mesh-resq/
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
├── app/
│   ├── __init__.py
│   ├── main.py
│   ├── database.py
│   ├── schemas.py
│   ├── spatial_utils.py
│   ├── routing_engine.py    # Motor de grafos (NetworkX / OSMnx / Dijkstra)
│   └── static/
│       ├── cliente/          # PWA del Rescatista (HTML/JS/CSS)
│       │   ├── index.html
│       │   ├── app.js
│       │   ├── sw.js
│       │   └── manifest.json
│       └── control/          # Dashboard de Mando (HTML/JS/Leaflet)
│           ├── index.html
│           └── dashboard.js
```

---

## 6. INSTRUCCIONES DE DESARROLLO PASO A PASO PARA LA IA

Al procesar este archivo, la IA receptora debe generar el código ejecutable para los siguientes módulos:

### Módulo 1: Backend Espacial y Motor de Ruteo (`app/main.py` y `app/routing_engine.py`)
* Configurar PostgreSQL + PostGIS con SQLAlchemy.
* Implementar `routing_engine.py` cargando un mapa base local de OpenStreetMap mediante `osmnx` o `networkx`.
* Crear método `bloquear_nodo_o_arista(lat, lon, radio)` que asigne peso infinito a las calles afectadas dentro del mapa vial.
* Implementar la función `calcular_ruta_optima()` usando el algoritmo de Dijkstra sobre el grafo ajustado dinámicamente.

### Módulo 2: Cliente Móvil PWA (`app/static/cliente/`)
* Diseñar interfaz móvil *Dark Mode* con botón flotante táctil de reporte rápido ("Reportar Bloqueo Vial").
* Capturar ubicación GNSS mediante `navigator.geolocation.watchPosition` (`enableHighAccuracy: true`).
* Guardar reportes de bloqueo y coordenadas en `IndexedDB` si no hay señal con la red Mesh.
* Sincronizar cola local al detectar conexión con `POST /api/bloqueos/` o `POST /api/telemetria/batch`.

### Módulo 3: Dashboard Estación de Control (`app/static/control/`)
* Interfaz con mapa Leaflet.js de pantalla completa y panel lateral de control de capas.
* Representación gráfica de elementos:
  * Marcadores de rescate en movimiento.
  * Zonas peinadas en polígonos verdes transparentes.
  * Íconos de advertencia `⚠️` con círculos rojos sobre las calles/zonas reportadas con bloqueo.
  * Trazado de línea de ruta óptima (en color azul brillante o neón) que rodee automáticamente los bloqueos viales.
* Conexión a WebSocket `/ws/control` para redibujar la ruta en vivo cada vez que un rescatista reporte un nuevo bloqueo.

---

## 7. CRITERIOS DE ACEPTACIÓN / PRUEBAS TÁCTICAS

1. **Simulación Offline:** Al apagar la red en el teléfono cliente y registrar 5 puntos de posición y 1 bloqueo vial por escombros, la PWA guarda los datos localmente en `IndexedDB` sin errores.
2. **Sincronización:** Al reconectar la red, los bloqueos y posiciones se transmiten a PostGIS con sus timestamps originales.
3. **Re-enrutamiento en Tiempo Real:** Al trazar una ruta entre A y B, y posteriormente registrar un bloqueo en medio del trayecto, el motor debe invalidar ese tramo vial y la API debe devolver una ruta alternativa que esquive la zona bloqueada.