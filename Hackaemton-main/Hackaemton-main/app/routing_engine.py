"""Motor de ruteo dinámico táctico (NetworkX + Dijkstra).

Responsabilidades:

1. Cargar un grafo vial local (``.graphml`` generado con OSMnx) o, si no
   existe, construir un grafo sintético en rejilla para que la API arranque
   sin dependencias de red.
2. Mantener un registro de bloqueos activos.
3. ``bloquear_nodo_o_arista(lat, lon, radio)``: asigna **peso infinito** a
   todas las aristas y desactiva los nodos que caen dentro del radio de un
   bloqueo.
4. ``calcular_ruta_optima(...)``: aplica Dijkstra sobre el grafo ajustado en
   tiempo real para esquivar calles bloqueadas.

El grafo activo se reconstruye de forma perezosa (*lazy*) y se cachea hasta
que se registra o libera un bloqueo.
"""

from __future__ import annotations

import math
import os
from typing import Dict, List, Optional, Sequence, Tuple

import networkx as nx

from .spatial_utils import distancia_punto_segmento_m, haversine_m

try:  # pragma: no cover - opcional (para geometrías WKT de GraphML de OSMnx)
    from shapely import wkt as shapely_wkt

    HAS_SHAPELY_WKT = True
except Exception:  # pragma: no cover
    shapely_wkt = None  # type: ignore[assignment]
    HAS_SHAPELY_WKT = False

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUTA_GRAFO_ACAPULCO = os.path.join(BASE_DIR, "data", "acapulco", "grafo.graphml")
RUTA_GRAFO_GENERICO = os.path.join(BASE_DIR, "data", "grafo.graphml")
# Acapulco es el escenario por defecto; si no existe su grafo se usa el
# genérico (por ejemplo, Puebla) para no romper instalaciones previas.
RUTA_GRAFO_POR_DEFECTO = (
    RUTA_GRAFO_ACAPULCO if os.path.exists(RUTA_GRAFO_ACAPULCO) else RUTA_GRAFO_GENERICO
)

# Centro por defecto (Acapulco de Juárez, Guerrero, MX) para la rejilla
# sintética cuando no hay un grafo OSM disponible.
CENTRO_LAT = float(os.getenv("MESH_RESQ_CENTRO_LAT", "16.8680495"))
CENTRO_LON = float(os.getenv("MESH_RESQ_CENTRO_LON", "-99.8940182"))
NODOS_REJILLA = int(os.getenv("MESH_RESQ_NODOS", "15"))
ESPACIADO_M = float(os.getenv("MESH_RESQ_ESPACIADO_M", "120"))
VELOCIDAD_M_S = float(os.getenv("MESH_RESQ_VELOCIDAD_M_S", "8.33"))  # ~30 km/h


class RutaNoEncontrada(Exception):
    """No existe un camino viable entre el origen y el destino."""


# --------------------------------------------------------------------------- #
# Construcción de grafos
# --------------------------------------------------------------------------- #
def _coords_arista(data: dict, lat_u: float, lon_u: float, lat_v: float, lon_v: float):
    geom = data.get("geometry")
    if geom is not None and hasattr(geom, "coords"):
        return [[float(x), float(y)] for x, y in geom.coords]
    # GraphML de OSMnx guarda la geometría como WKT (texto).
    if isinstance(geom, str) and geom and HAS_SHAPELY_WKT:
        try:
            return [[float(x), float(y)] for x, y in shapely_wkt.loads(geom).coords]
        except Exception:  # pragma: no cover - geometría corrupta
            pass
    return [[lon_u, lat_u], [lon_v, lat_v]]


def _normalizar_grafo(G: nx.Graph) -> nx.DiGraph:
    """Convierte cualquier grafo (OSM/GraphML) a un ``DiGraph`` homogéneo.

    Cada nodo tiene ``x`` (lon) e ``y`` (lat); cada arista tiene ``length``
    en metros y ``coords`` como lista de ``[lon, lat]``.
    """

    H = nx.DiGraph()
    for n, data in G.nodes(data=True):
        lat = float(data.get("y", data.get("lat", 0.0)) or 0.0)
        lon = float(data.get("x", data.get("lon", 0.0)) or 0.0)
        H.add_node(str(n), y=lat, x=lon)

    dirigido = G.is_directed()
    for u, v, data in G.edges(data=True):
        u, v = str(u), str(v)
        if u not in H or v not in H:
            continue
        lu, lv = H.nodes[u], H.nodes[v]
        try:
            largo = float(data.get("length", 0.0) or 0.0)
        except (TypeError, ValueError):
            largo = 0.0
        if largo <= 0:
            largo = haversine_m(lu["y"], lu["x"], lv["y"], lv["x"])
        coords = _coords_arista(data, lu["y"], lu["x"], lv["y"], lv["x"])
        H.add_edge(u, v, length=largo, coords=coords, nombre=data.get("name"))
        if not dirigido and not H.has_edge(v, u):
            H.add_edge(
                v,
                u,
                length=largo,
                coords=list(reversed(coords)),
                nombre=data.get("name"),
            )
    return H


def cargar_grafo(ruta: Optional[str] = None) -> nx.DiGraph:
    """Carga el grafo vial local o genera la rejilla sintética de respaldo."""

    ruta = ruta or os.getenv("MESH_RESQ_GRAFO", RUTA_GRAFO_POR_DEFECTO)
    if os.path.exists(ruta):
        # ``read_graphml`` funciona tanto con los grafos generados por
        # scripts/descargar_mapa.py como con los exportados por OSMnx.
        G = nx.read_graphml(ruta)
        return _normalizar_grafo(G)
    return grafo_sintetico()


def grafo_sintetico(
    centro: Tuple[float, float] = (CENTRO_LAT, CENTRO_LON),
    n: int = NODOS_REJILLA,
    espaciado_m: float = ESPACIADO_M,
    con_diagonales: bool = True,
) -> nx.DiGraph:
    """Rejilla bidireccional de ``n x n`` nodos como mapa base de contingencia."""

    lat0, lon0 = centro
    metros_lon = 111320.0 * max(0.01, math.cos(math.radians(lat0)))
    dlat = espaciado_m / 110574.0
    dlon = espaciado_m / metros_lon

    H = nx.DiGraph()
    for i in range(n):
        for j in range(n):
            H.add_node(f"n_{i}_{j}", y=lat0 + i * dlat, x=lon0 + j * dlon)

    def conectar(a: str, b: str):
        if H.has_edge(a, b):
            return
        lu, lv = H.nodes[a], H.nodes[b]
        largo = haversine_m(lu["y"], lu["x"], lv["y"], lv["x"])
        coords = [[lu["x"], lu["y"]], [lv["x"], lv["y"]]]
        H.add_edge(a, b, length=largo, coords=coords, nombre=f"{a}-{b}")
        H.add_edge(b, a, length=largo, coords=list(reversed(coords)), nombre=f"{a}-{b}")

    for i in range(n):
        for j in range(n):
            actual = f"n_{i}_{j}"
            if j + 1 < n:
                conectar(actual, f"n_{i}_{j + 1}")
            if i + 1 < n:
                conectar(actual, f"n_{i + 1}_{j}")
            if con_diagonales and i + 1 < n and j + 1 < n:
                conectar(actual, f"n_{i + 1}_{j + 1}")
            if con_diagonales and i + 1 < n and j - 1 >= 0:
                conectar(actual, f"n_{i + 1}_{j - 1}")
    return H


# --------------------------------------------------------------------------- #
# Motor de ruteo
# --------------------------------------------------------------------------- #
class MotorRuteo:
    """Gestiona el grafo vial y responde consultas de ruta óptima."""

    def __init__(
        self,
        ruta_grafo: Optional[str] = None,
        velocidad_m_s: float = VELOCIDAD_M_S,
    ):
        self.ruta_grafo = ruta_grafo or os.getenv("MESH_RESQ_GRAFO", RUTA_GRAFO_POR_DEFECTO)
        self.velocidad_m_s = velocidad_m_s
        self._grafo_base = cargar_grafo(self.ruta_grafo)
        self._bloqueos: Dict[str, dict] = {}
        self._cache: Optional[nx.DiGraph] = None
        self._version = 0

    # -- Estado ------------------------------------------------------------ #
    @property
    def usando_grafo_osm(self) -> bool:
        return os.path.exists(self.ruta_grafo)

    @property
    def grafo(self) -> nx.DiGraph:
        if self._cache is None:
            self._cache = self._construir_grafo_activo()
        return self._cache

    def estado(self) -> dict:
        return {
            "fuente": self.ruta_grafo if self.usando_grafo_osm else "rejilla_sintetica",
            "nodos": self._grafo_base.number_of_nodes(),
            "aristas": self._grafo_base.number_of_edges(),
            "bloqueos_activos": len(self._bloqueos),
            "version": self._version,
            "velocidad_m_s": self.velocidad_m_s,
        }

    def centro(self) -> Tuple[float, float]:
        nodos = self._grafo_base.nodes(data=True)
        if not nodos:
            return CENTRO_LAT, CENTRO_LON
        lat = sum(d["y"] for _, d in nodos) / len(nodos)
        lon = sum(d["x"] for _, d in nodos) / len(nodos)
        return lat, lon

    # -- Bloqueos ---------------------------------------------------------- #
    def bloquear_nodo_o_arista(
        self,
        lat: float,
        lon: float,
        radio: float,
        identificador: Optional[str] = None,
    ) -> str:
        """Marca como intransitable todo lo que cae dentro de ``radio`` metros.

        A las aristas afectadas se les asigna ``length = +inf`` y los nodos
        dentro del radio quedan inutilizables (todas sus aristas se
        desactivan). Devuelve el identificador del bloqueo.
        """

        bid = identificador or f"B{len(self._bloqueos) + 1}"
        self._bloqueos[bid] = {"lat": float(lat), "lon": float(lon), "radio": float(radio)}
        self._cache = None
        self._version += 1
        return bid

    def liberar_bloqueo(self, identificador: str) -> bool:
        if identificador in self._bloqueos:
            del self._bloqueos[identificador]
            self._cache = None
            self._version += 1
            return True
        return False

    def limpiar_bloqueos(self) -> None:
        self._bloqueos.clear()
        self._cache = None
        self._version += 1

    def _construir_grafo_activo(self) -> nx.DiGraph:
        H = nx.DiGraph()
        H.add_nodes_from((n, dict(d)) for n, d in self._grafo_base.nodes(data=True))
        H.add_edges_from(
            (u, v, dict(d)) for u, v, d in self._grafo_base.edges(data=True)
        )

        for bloqueo in self._bloqueos.values():
            lat, lon, radio = bloqueo["lat"], bloqueo["lon"], bloqueo["radio"]
            nodos_bloqueados = [
                n
                for n, d in H.nodes(data=True)
                if haversine_m(lat, lon, d["y"], d["x"]) <= radio
            ]
            for u, v, d in H.edges(data=True):
                if u in nodos_bloqueados or v in nodos_bloqueados:
                    d["length"] = math.inf
                    d["bloqueado"] = True
                    continue
                if distancia_punto_segmento_m(lat, lon, d["coords"]) <= radio:
                    d["length"] = math.inf
                    d["bloqueado"] = True
        return H

    # -- Consultas --------------------------------------------------------- #
    def nodo_mas_cercano(self, lat: float, lon: float, solo_activos: bool = True) -> str:
        H = self.grafo
        mejor, mejor_dist = None, math.inf
        for n, d in H.nodes(data=True):
            if solo_activos and H.degree(n) == 0:
                continue
            dist = haversine_m(lat, lon, d["y"], d["x"])
            if dist < mejor_dist:
                mejor, mejor_dist = n, dist
        if mejor is None:
            raise RutaNoEncontrada("No hay nodos transitables en el grafo")
        return mejor

    def _coords_ruta(self, nodos: Sequence[str]) -> List[List[float]]:
        H = self.grafo
        coords: List[List[float]] = []
        for u, v in zip(nodos, nodos[1:]):
            data = H.get_edge_data(u, v)
            if data is None:
                continue
            tramo = data["coords"]
            inicio = [H.nodes[u]["x"], H.nodes[u]["y"]]
            fin = [H.nodes[v]["x"], H.nodes[v]["y"]]
            d_ini = haversine_m(tramo[0][1], tramo[0][0], inicio[1], inicio[0])
            d_fin = haversine_m(tramo[-1][1], tramo[-1][0], inicio[1], inicio[0])
            if d_fin < d_ini:
                tramo = list(reversed(tramo))
            if coords and coords[-1] == tramo[0]:
                coords.extend(tramo[1:])
            else:
                coords.extend(tramo)
        return coords

    def calcular_ruta_optima(
        self,
        origen_lat: float,
        origen_lon: float,
        destino_lat: float,
        destino_lon: float,
        velocidad_m_s: Optional[float] = None,
    ) -> dict:
        """Ruta más corta (Dijkstra) esquivando los bloqueos activos."""

        H = self.grafo
        nodo_o = self.nodo_mas_cercano(origen_lat, origen_lon)
        nodo_d = self.nodo_mas_cercano(destino_lat, destino_lon)

        try:
            nodos = nx.dijkstra_path(H, nodo_o, nodo_d, weight="length")
            costo = nx.dijkstra_path_length(H, nodo_o, nodo_d, weight="length")
        except (nx.NetworkXNoPath, nx.NodeNotFound) as exc:
            raise RutaNoEncontrada(
                "No existe una ruta transitable entre el origen y el destino "
                "con los bloqueos activos"
            ) from exc

        if not math.isfinite(costo):
            raise RutaNoEncontrada(
                "Todas las rutas posibles atraviesan zonas bloqueadas"
            )

        velocidad = velocidad_m_s or self.velocidad_m_s
        coords = self._coords_ruta(nodos)
        if not coords:
            coords = [[origen_lon, origen_lat], [destino_lon, destino_lat]]

        distancia = float(costo)
        duracion = distancia / velocidad if velocidad > 0 else 0.0
        return {
            "distancia_m": round(distancia, 2),
            "duracion_s": round(duracion, 2),
            "velocidad_m_s": velocidad,
            "nodos": len(nodos),
            "coordenadas": coords,
            "origen_ajustado": [nodo_o, H.nodes[nodo_o]["x"], H.nodes[nodo_o]["y"]],
            "destino_ajustado": [nodo_d, H.nodes[nodo_d]["x"], H.nodes[nodo_d]["y"]],
            "geojson": {
                "type": "LineString",
                "coordinates": coords,
            },
        }


# --------------------------------------------------------------------------- #
# Instancia única (singleton) usada por la API
# --------------------------------------------------------------------------- #
_motor: Optional[MotorRuteo] = None


def obtener_motor() -> MotorRuteo:
    global _motor
    if _motor is None:
        _motor = MotorRuteo()
    return _motor
