# `data/` — Grafos viales locales

El **motor de ruteo** (`app/routing_engine.py`) usa por defecto:

1. `data/grafo.graphml` — escenario por defecto (**Puebla**).
2. `data/acapulco/grafo.graphml` — escenario Acapulco (opcional; se activa con
   `MESH_RESQ_GRAFO=./data/acapulco/grafo.graphml`).
3. Si no existe ninguno, una **rejilla sintética** (15×15 nodos, 120 m)
   centrada en `MESH_RESQ_CENTRO_LAT/LON` (Puebla por defecto).

Así puedes conservar varios escenarios sin que se pisen entre sí.

## Generar un grafo OSM real

```bash
# Puebla por defecto (no requiere osmnx: usa Overpass + NetworkX)
python scripts/descargar_mapa.py
# -> data/grafo.graphml  (radio 4 km)

# Acapulco (opcional):
python scripts/descargar_mapa.py --lat 16.868 --lon -99.894 \
    --salida data/acapulco/grafo.graphml
```

Reinicia el nodo (o llama a `GET /health`) y el motor usará la red vial real.
El contenedor `app` monta `./data` como volumen, por lo que también puedes
colocar el archivo manualmente.
