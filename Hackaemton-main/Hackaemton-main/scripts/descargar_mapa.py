#!/usr/bin/env python3
"""Descarga la red vial real de OpenStreetMap y la guarda como GraphML.

Usa la API pública de **Overpass** y NetworkX, así que **no necesita osmnx**
(ni GDAL/GEOS). Sin este archivo el motor de ruteo usa una rejilla sintética.

Por defecto descarga Acapulco de Juárez, Guerrero (MX), el área de operación
del proyecto::

    python scripts/descargar_mapa.py
    # -> data/acapulco/grafo.graphml  (4 km alrededor del centro de Acapulco)

Opciones::

    python scripts/descargar_mapa.py --lat 16.868 --lon -99.894 --dist 5000
    python scripts/descargar_mapa.py --bbox 16.83,-99.93,16.91,-99.85
    python scripts/descargar_mapa.py --salida /tmp/acapulco.graphml

Los datos de OpenStreetMap están bajo la licencia ODbL:
https://www.openstreetmap.org/copyright
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

import networkx as nx

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA_POR_DEFECTO = os.path.join(RAIZ, "data", "acapulco", "grafo.graphml")

# Acapulco de Juárez, Guerrero, México (nodo `place=city` de OSM).
CENTRO_LAT = 16.8680495
CENTRO_LON = -99.8940182

OVERPASS = os.getenv("MESH_RESQ_OVERPASS", "https://overpass-api.de/api/interpreter")
UA = "Mesh-ResQ-GNSS/1.0 (hackathon; descarga unica de red vial)"
R_TIERRA_M = 6371008.8

# Vías transitables por vehículos de emergencia.
HIGHWAY = (
    "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
    "service|living_street|road|motorway_link|trunk_link|primary_link|"
    "secondary_link|tertiary_link)$"
)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_TIERRA_M * math.asin(math.sqrt(a))


def bbox_desde_radio(lat: float, lon: float, radio_m: float):
    dlat = radio_m / 110574.0
    dlon = radio_m / (111320.0 * max(0.01, math.cos(math.radians(lat))))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def descargar_overpass(sur: float, oeste: float, norte: float, este: float, timeout: int):
    consulta = f"""[out:json][timeout:{timeout}];
(
  way["highway"~"{HIGHWAY}"]({sur:.7f},{oeste:.7f},{norte:.7f},{este:.7f});
);
(._;>;);
out body;"""
    datos = urllib.parse.urlencode({"data": consulta}).encode("utf-8")
    req = urllib.request.Request(OVERPASS, data=datos, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout + 60) as resp:
        return json.load(resp)


def construir_grafo(datos: dict) -> tuple[nx.DiGraph, int]:
    nodos: dict[int, tuple[float, float]] = {}
    ways: list[dict] = []
    for el in datos.get("elements", []):
        if el.get("type") == "node":
            nodos[el["id"]] = (float(el["lat"]), float(el["lon"]))
        elif el.get("type") == "way" and el.get("nodes"):
            ways.append(el)

    G = nx.DiGraph()
    for nid, (lat, lon) in nodos.items():
        G.add_node(str(nid), y=lat, x=lon)

    tramos = 0
    for way in ways:
        tags = way.get("tags", {})
        nds = [n for n in way.get("nodes", []) if n in nodos]
        if len(nds) < 2:
            continue

        oneway = (tags.get("oneway") or "").lower()
        if tags.get("junction") == "roundabout":
            oneway = "yes"
        bidireccional = oneway not in ("yes", "true", "1")
        invertida = oneway == "-1"
        nombre = tags.get("name") or ""

        for a, b in zip(nds, nds[1:]):
            la, loa = nodos[a]
            lb, lob = nodos[b]
            largo = haversine_m(la, loa, lb, lob)
            if invertida:
                G.add_edge(str(b), str(a), length=largo, name=nombre)
            elif bidireccional:
                G.add_edge(str(a), str(b), length=largo, name=nombre)
                G.add_edge(str(b), str(a), length=largo, name=nombre)
            else:
                G.add_edge(str(a), str(b), length=largo, name=nombre)
            tramos += 1

    return G, tramos


def main() -> int:
    ap = argparse.ArgumentParser(description="Descarga la red vial OSM como GraphML.")
    ap.add_argument("--lat", type=float, default=CENTRO_LAT)
    ap.add_argument("--lon", type=float, default=CENTRO_LON)
    ap.add_argument("--dist", type=int, default=4000, help="radio en metros (def. 4000)")
    ap.add_argument("--bbox", help="alternativa: sur,oeste,norte,este")
    ap.add_argument("--salida", default=SALIDA_POR_DEFECTO)
    ap.add_argument("--timeout", type=int, default=180, help="timeout de Overpass (s)")
    ap.add_argument(
        "--conservar-todo",
        action="store_true",
        help="no recortar a la componente conectada más grande",
    )
    args = ap.parse_args()

    if args.bbox:
        try:
            sur, oeste, norte, este = (float(v) for v in args.bbox.split(","))
        except ValueError:
            print("❌ --bbox debe ser sur,oeste,norte,este", file=sys.stderr)
            return 2
    else:
        sur, oeste, norte, este = bbox_desde_radio(args.lat, args.lon, args.dist)

    alto_km = (norte - sur) * 110.574
    ancho_km = (este - oeste) * 111.32 * math.cos(math.radians((sur + norte) / 2))
    print(
        f"⬇️  Descargando red vial de Acapulco/OSM\n"
        f"   bbox {sur:.5f},{oeste:.5f} → {norte:.5f},{este:.5f} "
        f"(~{ancho_km:.1f} × {alto_km:.1f} km)"
    )
    try:
        datos = descargar_overpass(sur, oeste, norte, este, args.timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        print(f"❌ No se pudo consultar Overpass: {exc}", file=sys.stderr)
        print("   Reintenta en unos minutos o usa --bbox más pequeño.", file=sys.stderr)
        return 1

    G, tramos = construir_grafo(datos)
    if G.number_of_nodes() == 0:
        print("❌ Overpass no devolvió nodos para esa área.", file=sys.stderr)
        return 1

    descartados = 0
    if not args.conservar_todo:
        componentes = list(nx.weakly_connected_components(G))
        if componentes:
            principal = max(componentes, key=len)
            descartados = G.number_of_nodes() - len(principal)
            G = G.subgraph(principal).copy()

    os.makedirs(os.path.dirname(os.path.abspath(args.salida)), exist_ok=True)
    nx.write_graphml(G, args.salida)
    tam_mb = os.path.getsize(args.salida) / (1024 * 1024)

    print(f"✅ Grafo guardado en {args.salida} ({tam_mb:.1f} MB)")
    print(f"   {G.number_of_nodes():,} nodos · {G.number_of_edges():,} aristas · {tramos:,} tramos OSM")
    if descartados:
        print(f"   ({descartados:,} nodos aislados descartados)")
    print("   Reinicia el backend para que el motor de ruteo lo cargue.")
    print("   Datos © OpenStreetMap contributors (ODbL).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
