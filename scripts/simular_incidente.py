#!/usr/bin/env python3
"""Simulación táctica de extremo a extremo contra un nodo Mesh-ResQ en marcha.

Genera telemetría de dos cuadrillas, un bloqueo de escombros y comprueba el
re-enrutamiento en tiempo real (criterios de aceptación 1-3).

Uso:
    python scripts/simular_incidente.py --url http://localhost:8000
"""
from __future__ import annotations

import argparse
import json
import math
import random
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone


def peticion(url: str, metodo: str = "GET", cuerpo: dict | None = None):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(
        url, data=datos, method=metodo, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def desplazar(lat: float, lon: float, rumbo: float, metros: float):
    dlat = metros * math.cos(math.radians(rumbo)) / 110574.0
    dlon = metros * math.sin(math.radians(rumbo)) / (111320.0 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--rescatistas", type=int, default=3)
    args = ap.parse_args()
    base = args.url.rstrip("/")

    cfg = peticion(f"{base}/api/config")
    clat, clon = cfg["centro"]["lat"], cfg["centro"]["lon"]
    print(f"📍 Centro de operaciones: {clat:.5f}, {clon:.5f}  (grafo: {cfg['fuente_grafo']})")

    # 1) Telemetría de varias cuadrillas (simula lote acumulado offline).
    ahora = datetime.now(timezone.utc)
    for r in range(args.rescatistas):
        puntos = []
        for i in range(5):
            lat, lon = desplazar(clat, clon, random.uniform(0, 360), random.uniform(0, 400))
            puntos.append(
                {
                    "lat": lat,
                    "lon": lon,
                    "altitud": 2100 + random.uniform(-15, 15),
                    "precision_m": random.uniform(3, 12),
                    "timestamp": (ahora - timedelta(seconds=(5 - i) * 20)).isoformat(),
                    "rescatista_id": f"R-{r + 1}",
                    "cuadrilla": f"CUADRILLA-{r + 1}",
                }
            )
        res = peticion(
            f"{base}/api/telemetria/batch",
            "POST",
            {"rescatista_id": f"R-{r + 1}", "cuadrilla": f"CUADRILLA-{r + 1}", "puntos": puntos},
        )
        print(f"  ✅ Telemetría R-{r + 1}: {res['insertados']} puntos")

    # 2) Riesgo puntual.
    rlat, rlon = desplazar(clat, clon, 45, 250)
    peticion(f"{base}/api/riesgos/", "POST", {
        "tipo_riesgo": "FUGA_GAS", "nivel_gravedad": 4,
        "lat": rlat, "lon": rlon, "radio_afectacion_m": 35,
        "descripcion": "Fuga detectada en toma principal",
    })
    print("  ✅ Riesgo FUGA_GAS registrado")

    # 3) Zona peinada por buffer de recorrido.
    recorrido = []
    for i in range(12):
        lat, lon = desplazar(clat, clon, 200, i * 20)
        recorrido.append([lon, lat])
    z = peticion(f"{base}/api/zonas-peinadas/", "POST", {
        "cuadrilla_id": "CUADRILLA-1", "recorrido": recorrido, "radio_m": 25,
        "observaciones": "Barrido lineal manzana norte",
    })
    print(f"  ✅ Zona peinada #{z['id']} generada por buffer")

    # 4) Ruta ANTES del bloqueo.
    o = desplazar(clat, clon, 180, 500)
    d = desplazar(clat, clon, 0, 500)
    consulta = (
        f"{base}/api/ruteo/optimo?origen_lat={o[0]}&origen_lon={o[1]}"
        f"&destino_lat={d[0]}&destino_lon={d[1]}"
    )
    antes = peticion(consulta)
    print(f"\n🧭 Ruta inicial: {antes['distancia_m']:.0f} m · {antes['nodos']} nodos")

    # 5) Bloqueo en pleno trayecto (punto medio de la ruta original).
    medio = antes["coordenadas"][len(antes["coordenadas"]) // 2]
    b = peticion(f"{base}/api/bloqueos/", "POST", {
        "tipo_obstaculo": "ESCOMBROS", "lat": medio[1], "lon": medio[0],
        "radio_bloqueo_m": 40, "descripcion": "Vía cubierta por escombros",
        "rescatista_id": "R-1",
    })
    print(f"⛔ Bloqueo #{b['id']} de ESCOMBROS en {medio[1]:.5f}, {medio[0]:.5f}")

    # 6) Ruta DESPUÉS del bloqueo -> debe esquivarlo.
    despues = peticion(consulta)
    print(f"🧭 Ruta recalculada: {despues['distancia_m']:.0f} m · {despues['nodos']} nodos "
          f"· bloqueos esquivados {despues['bloqueos_esquivados']}")

    if abs(despues["distancia_m"] - antes["distancia_m"]) < 1e-6 and antes["coordenadas"] == despues["coordenadas"]:
        print("⚠️  La ruta no cambió: el bloqueo no afectó el trayecto (prueba con otro punto).")
    else:
        print("✅ Re-enrutamiento verificado: la ruta cambió para esquivar el bloqueo.")

    estado = peticion(f"{base}/api/control/estado-global")
    print(f"\n📊 Estado global: {estado['metadata']['conteos']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.URLError as exc:
        print(f"❌ No se pudo conectar al nodo Mesh-ResQ: {exc}")
        raise SystemExit(1)
