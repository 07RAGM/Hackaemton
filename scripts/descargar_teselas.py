#!/usr/bin/env python3
"""Descarga teselas de mapa para verlo **offline** en el dashboard.

Guarda las teselas en ``app/static/control/tiles_acapulco/{z}/{x}/{y}.png`` y luego el
dashboard las sirve desde el propio nodo mesh (sin internet ni API keys).

Uso típico (Acapulco, ~2.5 km alrededor del centro, zooms 13-17):

    python scripts/descargar_teselas.py
    # equivale a: --lat 16.8680495 --lon -99.8940182 \
    #             --radio 2500 --zoom-min 13 --zoom-max 17

Después define en el entorno del backend:

    MESH_RESQ_TILES_URL=/control/tiles_acapulco/{z}/{x}/{y}.png
    MESH_RESQ_TILES_ATRIBUCION="© OpenStreetMap contributors"
    # MESH_RESQ_TILES_OSCURECER=1   # 0 si tu fuente ya es oscura

Requiere sólo la biblioteca estándar. Por defecto usa el servidor de
OpenStreetMap Alemania (FOSSGIS), que permite descargas moderadas; el servidor
principal de OSM bloquea lotes. Respeta la política de uso de la fuente que
elijas: descarga áreas pequeñas y no ejecutes el script en bucle.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA_POR_DEFECTO = os.path.join(RAIZ, "app", "static", "control", "tiles_acapulco")
# Servidor de teselas de OpenStreetMap Alemania (FOSSGIS). El servidor
# principal (tile.openstreetmap.org) bloquea descargas por lotes.
FUENTE_POR_DEFECTO = "https://tile.openstreetmap.de/{z}/{x}/{y}.png"
UA = "Mesh-ResQ-GNSS/1.0 (offline rescue demo)"


def lon_a_tile(lon: float, z: int) -> int:
    return int((lon + 180.0) / 360.0 * (2 ** z))


def lat_a_tile(lat: float, z: int) -> int:
    rad = math.radians(max(-85.05112878, min(85.05112878, lat)))
    return int((1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0 * (2 ** z))


def rango_teselas(min_lat, min_lon, max_lat, max_lon, z):
    return (
        lon_a_tile(min_lon, z),
        lon_a_tile(max_lon, z),
        lat_a_tile(max_lat, z),
        lat_a_tile(min_lat, z),
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Descarga teselas de mapa para uso offline.")
    ap.add_argument("--lat", type=float, default=16.8680495, help="centro del área (Acapulco)")
    ap.add_argument("--lon", type=float, default=-99.8940182, help="centro del área (Acapulco)")
    ap.add_argument("--radio", type=float, default=2500, help="radio en metros (por defecto 2500)")
    ap.add_argument("--bbox", type=str, help="alternativa: min_lat,min_lon,max_lat,max_lon")
    ap.add_argument("--zoom-min", type=int, default=13)
    ap.add_argument("--zoom-max", type=int, default=17)
    ap.add_argument("--fuente", default=FUENTE_POR_DEFECTO, help="plantilla {z}/{x}/{y}")
    ap.add_argument("--salida", default=SALIDA_POR_DEFECTO)
    ap.add_argument("--max-teselas", type=int, default=3000, help="límite de seguridad")
    ap.add_argument("--pausa", type=float, default=0.12, help="segundos entre descargas")
    args = ap.parse_args()

    if args.bbox:
        try:
            min_lat, min_lon, max_lat, max_lon = (float(v) for v in args.bbox.split(","))
        except ValueError:
            print("❌ --bbox debe ser min_lat,min_lon,max_lat,max_lon", file=sys.stderr)
            return 2
    elif args.lat is not None and args.lon is not None:
        dlat = args.radio / 110574.0
        dlon = args.radio / (111320.0 * max(0.01, math.cos(math.radians(args.lat))))
        min_lat, max_lat = args.lat - dlat, args.lat + dlat
        min_lon, max_lon = args.lon - dlon, args.lon + dlon
    else:
        ap.error("indica --lat/--lon o --bbox")

    if args.zoom_max < args.zoom_min:
        ap.error("--zoom-max debe ser >= --zoom-min")

    # 1) Calcular el total antes de descargar.
    trabajo = []
    for z in range(args.zoom_min, args.zoom_max + 1):
        x0, x1, y0, y1 = rango_teselas(min_lat, min_lon, max_lat, max_lon, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                trabajo.append((z, x, y))
    total = len(trabajo)
    print(f"🗺  Área: {min_lat:.5f},{min_lon:.5f} → {max_lat:.5f},{max_lon:.5f}")
    print(f"   Zooms {args.zoom_min}-{args.zoom_max} · {total} teselas a descargar")
    if total > args.max_teselas:
        print(
            f"❌ {total} teselas supera el límite de {args.max_teselas}. "
            f"Reduce --radio, --zoom-max o sube --max-teselas.",
            file=sys.stderr,
        )
        return 1

    # 2) Descargar con pausa para no saturar la fuente.
    os.makedirs(args.salida, exist_ok=True)
    descargadas = omitidas = fallidas = 0
    for i, (z, x, y) in enumerate(trabajo, 1):
        destino_dir = os.path.join(args.salida, str(z), str(x))
        destino = os.path.join(destino_dir, f"{y}.png")
        if os.path.exists(destino):
            omitidas += 1
            continue
        os.makedirs(destino_dir, exist_ok=True)
        url = args.fuente.format(z=z, x=x, y=y, s="a")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                datos = resp.read()
            with open(destino, "wb") as fh:
                fh.write(datos)
            descargadas += 1
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            fallidas += 1
            print(f"   ⚠ {z}/{x}/{y}: {exc}", file=sys.stderr)
        if i % 50 == 0 or i == total:
            print(f"   {i}/{total}  (nuevas {descargadas}, ya existían {omitidas})")
        time.sleep(args.pausa)

    print(f"\n✅ Teselas en {args.salida}")
    print(f"   nuevas {descargadas} · ya existían {omitidas} · fallidas {fallidas}")
    # Metadatos de cobertura: el dashboard los usa para no pedir teselas fuera
    # del área descargada (y mostrar la retícula táctica alrededor).
    meta = {
        "bbox": [min_lat, min_lon, max_lat, max_lon],
        "zoom_min": args.zoom_min,
        "zoom_max": args.zoom_max,
        "fuente": args.fuente,
        "atribucion": "© OpenStreetMap contributors",
        "teselas": total,
    }
    with open(os.path.join(args.salida, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    print(f"   cobertura {min_lat:.5f},{min_lon:.5f} → {max_lat:.5f},{max_lon:.5f}")
    print("\nConfigura el backend y reinícialo:")
    print(f'   MESH_RESQ_TILES_URL="/control/tiles/{{z}}/{{x}}/{{y}}.png"')
    print('   MESH_RESQ_TILES_ATRIBUCION="© OpenStreetMap contributors"')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
