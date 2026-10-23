"""Configuración compartida de las pruebas de Mesh-ResQ GNSS.

Fuerza un SQLite temporal y una rejilla sintética para que la suite sea
completamente autocontenida (no requiere PostGIS ni descargar mapas).
"""

from __future__ import annotations

import os
import pathlib
import sys
import tempfile

RAIZ = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

# Debe definirse ANTES de importar app.database.
_TMP = pathlib.Path(tempfile.mkdtemp(prefix="meshresq-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP / 'test.db'}"
os.environ["MESH_RESQ_GRAFO"] = str(_TMP / "inexistente.graphml")  # -> rejilla sintética
# Centro de la rejilla de pruebas (Acapulco): debe coincidir con el default
# del motor antes de importarlo.
os.environ["MESH_RESQ_CENTRO_LAT"] = "16.8680495"
os.environ["MESH_RESQ_CENTRO_LON"] = "-99.8940182"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture()
def cliente():
    from app.database import Base, engine
    from app.main import app
    from app.routing_engine import obtener_motor

    Base.metadata.drop_all(engine)
    obtener_motor().limpiar_bloqueos()

    with TestClient(app) as c:
        yield c

    obtener_motor().limpiar_bloqueos()


@pytest.fixture()
def centro() -> dict:
    return {
        "lat": float(os.environ["MESH_RESQ_CENTRO_LAT"]),
        "lon": float(os.environ["MESH_RESQ_CENTRO_LON"]),
    }
