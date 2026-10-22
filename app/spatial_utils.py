"""Utilidades geoespaciales en Python puro (+ Shapely cuando está disponible).

Se usan para:

* Distancias geodésicas (Haversine) y proyección de puntos por rumbo.
* Generación de círculos y buffers de recorrido en GeoJSON.
* Test de punto-en-polígono y distancia punto-segmento (usado por el motor
  de ruteo para decidir qué aristas caen dentro de un bloqueo).

Al operar sobre un área pequeña (rescate urbano) se usa una proyección
equirectangular local, que es exacta a escala de kilómetros y mucho más
rápida que una reproyección formal.
"""

from __future__ import annotations

import math
from typing import Iterable, List, Sequence, Tuple

R_TIERRA_M = 6371008.8
METROS_POR_GRADO_LAT = 110574.0

try:  # pragma: no cover - depende del entorno
    from shapely.geometry import LineString, Point, Polygon
    from shapely.geometry import mapping as _shapely_mapping

    HAS_SHAPELY = True
except Exception:  # pragma: no cover
    HAS_SHAPELY = False


# --------------------------------------------------------------------------- #
# Geodesia básica
# --------------------------------------------------------------------------- #
def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distancia en metros entre dos coordenadas usando Haversine."""

    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    )
    return 2.0 * R_TIERRA_M * math.asin(min(1.0, math.sqrt(a)))


def metros_por_grado_lon(lat: float) -> float:
    return 111320.0 * max(0.01, math.cos(math.radians(lat)))


def destino(lat: float, lon: float, rumbo_deg: float, distancia_m: float) -> Tuple[float, float]:
    """Punto (lat, lon) a ``distancia_m`` desde ``(lat, lon)`` en ``rumbo_deg``."""

    rumbo = math.radians(rumbo_deg)
    dlat = (distancia_m * math.cos(rumbo)) / METROS_POR_GRADO_LAT
    dlon = (distancia_m * math.sin(rumbo)) / metros_por_grado_lon(lat)
    return lat + dlat, lon + dlon


# --------------------------------------------------------------------------- #
# Geometrías
# --------------------------------------------------------------------------- #
def circulo_poligono(lat: float, lon: float, radio_m: float, puntos: int = 48) -> dict:
    """Círculo GeoJSON ``Polygon`` alrededor de un punto."""

    anillo: List[List[float]] = []
    for i in range(puntos):
        rumbo = 360.0 * i / puntos
        plat, plon = destino(lat, lon, rumbo, radio_m)
        anillo.append([plon, plat])
    anillo.append(anillo[0])
    return {"type": "Polygon", "coordinates": [anillo]}


def _proyeccion_local(puntos: Sequence[Sequence[float]]):
    """Devuelve funciones proyectar/invertir alrededor del centroide."""

    lat0 = sum(p[1] for p in puntos) / len(puntos)
    lon0 = sum(p[0] for p in puntos) / len(puntos)
    m_lon = metros_por_grado_lon(lat0)

    def proyectar(lon: float, lat: float) -> Tuple[float, float]:
        return (lon - lon0) * m_lon, (lat - lat0) * METROS_POR_GRADO_LAT

    def invertir(x: float, y: float) -> Tuple[float, float]:
        return lon0 + x / m_lon, lat0 + y / METROS_POR_GRADO_LAT

    return proyectar, invertir


def _convex_hull(puntos: Iterable[Tuple[float, float]]) -> List[Tuple[float, float]]:
    """Envolvente convexa (monotone chain) para el *fallback* sin Shapely."""

    puntos = sorted(set(puntos))
    if len(puntos) <= 2:
        return list(puntos)

    def cruz(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    inferior: List[Tuple[float, float]] = []
    for p in puntos:
        while len(inferior) >= 2 and cruz(inferior[-2], inferior[-1], p) <= 0:
            inferior.pop()
        inferior.append(p)
    superior: List[Tuple[float, float]] = []
    for p in reversed(puntos):
        while len(superior) >= 2 and cruz(superior[-2], superior[-1], p) <= 0:
            superior.pop()
        superior.append(p)
    return inferior[:-1] + superior[:-1]


def buffer_recorrido(
    puntos: Sequence[Sequence[float]],
    radio_m: float,
) -> dict:
    """Buffer de un recorrido (lista de ``[lon, lat]``) con radio en metros.

    Devuelve un ``Polygon`` GeoJSON. Con Shapely usa un buffer real sobre el
    trazado; sin Shapely aproxima con la envolvente convexa de los círculos.
    """

    pts = [(float(p[0]), float(p[1])) for p in puntos]
    if not pts:
        raise ValueError("El recorrido está vacío")
    if len(pts) == 1:
        return circulo_poligono(pts[0][1], pts[0][0], radio_m)

    if HAS_SHAPELY:
        proyectar, invertir = _proyeccion_local(pts)
        forma = LineString([proyectar(lon, lat) for lon, lat in pts])
        buffer = forma.buffer(radio_m, resolution=8, join_style=1, cap_style=1)
        if buffer.geom_type != "Polygon":
            buffer = buffer.buffer(0)
        anillo = [list(invertir(x, y)) for x, y in buffer.exterior.coords]
        return {"type": "Polygon", "coordinates": [anillo]}

    # Fallback: envolvente convexa de los círculos de cada punto.
    muestras: List[Tuple[float, float]] = []
    for lon, lat in pts:
        for i in range(24):
            plat, plon = destino(lat, lon, 360.0 * i / 24, radio_m)
            muestras.append((plon, plat))
    hull = _convex_hull(muestras)
    hull.append(hull[0])
    return {"type": "Polygon", "coordinates": [[list(p) for p in hull]]}


def punto_en_poligono(lon: float, lat: float, poligono: dict) -> bool:
    """Ray casting sobre el anillo exterior de un ``Polygon`` GeoJSON."""

    if poligono.get("type") != "Polygon":
        return False
    anillo = poligono["coordinates"][0]
    dentro = False
    j = len(anillo) - 1
    for i in range(len(anillo)):
        xi, yi = anillo[i][0], anillo[i][1]
        xj, yj = anillo[j][0], anillo[j][1]
        if ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        ):
            dentro = not dentro
        j = i
    return dentro


def distancia_punto_segmento_m(
    lat: float,
    lon: float,
    coords: Sequence[Sequence[float]],
) -> float:
    """Distancia mínima (m) de un punto a una polilínea ``[[lon, lat], ...]``."""

    if not coords:
        return math.inf
    if len(coords) == 1:
        return haversine_m(lat, lon, coords[0][1], coords[0][0])

    proyectar, _ = _proyeccion_local([[lon, lat], *coords])
    px, py = proyectar(lon, lat)
    mejor = math.inf
    for a, b in zip(coords, coords[1:]):
        ax, ay = proyectar(a[0], a[1])
        bx, by = proyectar(b[0], b[1])
        dx, dy = bx - ax, by - ay
        largo2 = dx * dx + dy * dy
        if largo2 == 0.0:
            t = 0.0
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / largo2))
        cx, cy = ax + t * dx, ay + t * dy
        mejor = min(mejor, math.hypot(px - cx, py - cy))
    return mejor


def bbox_poligono(poligono: dict) -> Tuple[float, float, float, float]:
    """(min_lon, min_lat, max_lon, max_lat) de un Polygon GeoJSON."""

    anillo = poligono["coordinates"][0]
    lons = [p[0] for p in anillo]
    lats = [p[1] for p in anillo]
    return min(lons), min(lats), max(lons), max(lats)
