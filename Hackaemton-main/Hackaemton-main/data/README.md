# `data/` — Grafos viales locales

El **motor de ruteo** (`app/routing_engine.py`) busca, en este orden:

1. `data/acapulco/grafo.graphml` — escenario por defecto (Acapulco).
2. `data/grafo.graphml` — grafo genérico (por ejemplo, Puebla).
3. Si no existe ninguno, una **rejilla sintética** (15×15 nodos, 120 m)
   centrada en `MESH_RESQ_CENTRO_LAT/LON` (Acapulco por defecto).

Así puedes conservar varios escenarios sin que se pisen entre sí.

## Generar un grafo OSM real

```bash
# Acapulco por defecto (no requiere osmnx: usa Overpass + NetworkX)
python scripts/descargar_mapa.py
# -> data/acapulco/grafo.graphml  (radio 4 km)

# Otro escenario, por ejemplo Puebla:
python scripts/descargar_mapa.py --lat 19.0433 --lon -98.1987 \
    --salida data/grafo.graphml
```

Reinicia el nodo (o llama a `GET /health`) y el motor usará la red vial real.
El contenedor `app` monta `./data` como volumen, por lo que también puedes
colocar el archivo manualmente.
