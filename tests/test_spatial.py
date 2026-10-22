"""Pruebas unitarias de las utilidades geoespaciales y el motor de ruteo."""

from __future__ import annotations

import math

from app.routing_engine import MotorRuteo, grafo_sintetico
from app.spatial_utils import (
    buffer_recorrido,
    circulo_poligono,
    distancia_punto_segmento_m,
    haversine_m,
    metros_por_grado_lon,
    punto_en_poligono,
)

PUEBLA = (19.0433, -98.1987)


def _rejilla_centrada(n: int = 9, espaciado_m: float = 100):
    """Rejilla con PUEBLA en un nodo central (para bloquear 'en medio')."""

    dlat = espaciado_m / 110574.0
    dlon = espaciado_m / metros_por_grado_lon(PUEBLA[0])
    medio = n // 2
    centro = (PUEBLA[0] - medio * dlat, PUEBLA[1] - medio * dlon)
    G = grafo_sintetico(centro=centro, n=n, espaciado_m=espaciado_m)
    return G, dlat, medio


def test_haversine_orden_de_magnitud():
    # ~111 km por grado de latitud.
    d = haversine_m(19.0, -98.0, 20.0, -98.0)
    assert 110_000 < d < 112_000


def test_destino_y_circulo():
    anillo = circulo_poligono(19.0433, -98.1987, 50)["coordinates"][0]
    assert len(anillo) == 49  # 48 puntos + cierre
    for lon, lat in anillo:
        assert 40 < haversine_m(19.0433, -98.1987, lat, lon) < 60


def test_buffer_recorrido_genera_poligono():
    recorrido = [[-98.2 + i * 0.0002, 19.04] for i in range(5)]
    poligono = buffer_recorrido(recorrido, 25)
    assert poligono["type"] == "Polygon"
    assert len(poligono["coordinates"][0]) >= 4


def test_buffer_punto_unico():
    poligono = buffer_recorrido([[-98.2, 19.04]], 30)
    assert poligono["type"] == "Polygon"


def test_punto_en_poligono():
    poligono = circulo_poligono(19.0, -98.0, 100)
    assert punto_en_poligono(-98.0, 19.0, poligono)
    assert not punto_en_poligono(-98.01, 19.01, poligono)


def test_distancia_punto_segmento():
    # Segmento horizontal de ~105 m; el punto está a ~50 m por encima del centro.
    coords = [[-98.0, 19.0], [-97.999, 19.0]]
    d = distancia_punto_segmento_m(19.00045, -97.9995, coords)
    assert 40 < d < 60
    # Sobre la línea -> distancia ~0.
    assert distancia_punto_segmento_m(19.0, -98.0, coords) < 1.0


# --------------------------------------------------------------------------- #
# Motor de ruteo
# --------------------------------------------------------------------------- #
def test_grafo_sintetico_conectado():
    n = 5
    G = grafo_sintetico(centro=PUEBLA, n=n, espaciado_m=100)
    assert G.number_of_nodes() == n * n
    pares = n * (n - 1) * 2 + (n - 1) * (n - 1) * 2  # horiz + vert + 2 diagonales
    assert G.number_of_edges() == 2 * pares


def test_ruta_sin_bloqueos_es_finita():
    motor = MotorRuteo(ruta_grafo="/no/existe.graphml")
    G, dlat, medio = _rejilla_centrada(n=9, espaciado_m=100)
    motor._grafo_base = G
    motor.limpiar_bloqueos()
    o = (PUEBLA[0] - 3 * dlat, PUEBLA[1])
    d = (PUEBLA[0] + 3 * dlat, PUEBLA[1])
    ruta = motor.calcular_ruta_optima(o[0], o[1], d[0], d[1])
    assert ruta["distancia_m"] > 0
    assert ruta["geojson"]["type"] == "LineString"
    assert len(ruta["coordenadas"]) >= 2


def test_bloqueo_asigna_peso_infinito_y_desvia():
    motor = MotorRuteo(ruta_grafo="/no/existe.graphml")
    G, dlat, medio = _rejilla_centrada(n=9, espaciado_m=100)
    motor._grafo_base = G
    motor.limpiar_bloqueos()

    o = (PUEBLA[0] - 3 * dlat, PUEBLA[1])
    d = (PUEBLA[0] + 3 * dlat, PUEBLA[1])
    base = motor.calcular_ruta_optima(o[0], o[1], d[0], d[1])

    # Bloqueo en el nodo central (justo entre origen y destino).
    motor.bloquear_nodo_o_arista(PUEBLA[0], PUEBLA[1], 90, identificador="B1")
    activo = motor.grafo
    bloqueadas = [dt for _, _, dt in activo.edges(data=True) if dt.get("bloqueado")]
    assert bloqueadas, "el bloqueo debió afectar aristas del grafo"
    assert all(math.isinf(dt["length"]) for dt in bloqueadas)

    recalculada = motor.calcular_ruta_optima(o[0], o[1], d[0], d[1])
    assert recalculada["coordenadas"] != base["coordenadas"]
    assert recalculada["distancia_m"] > base["distancia_m"]

    motor.liberar_bloqueo("B1")
    restaurada = motor.calcular_ruta_optima(o[0], o[1], d[0], d[1])
    assert restaurada["coordenadas"] == base["coordenadas"]


def test_bloqueo_imposibilita_ruta():
    motor = MotorRuteo(ruta_grafo="/no/existe.graphml")
    motor._grafo_base = grafo_sintetico(centro=PUEBLA, n=5, espaciado_m=100)
    motor.limpiar_bloqueos()
    # Radio enorme: inutiliza toda la red.
    motor.bloquear_nodo_o_arista(PUEBLA[0], PUEBLA[1], 100_000, identificador="TOTAL")
    from app.routing_engine import RutaNoEncontrada

    try:
        motor.calcular_ruta_optima(PUEBLA[0], PUEBLA[1], PUEBLA[0] + 0.001, PUEBLA[1])
    except RutaNoEncontrada:
        pass
    else:  # pragma: no cover
        raise AssertionError("Se esperaba RutaNoEncontrada con la red totalmente bloqueada")
