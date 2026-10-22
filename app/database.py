"""Configuración, motor de base de datos y modelos espaciales de Mesh-ResQ GNSS.

El objetivo de este módulo es exponer los modelos ``PosicionRescatista``,
``ZonaPeinada``, ``ReporteRiesgo`` y ``BloqueoVial`` con columnas geométricas
``Geometry`` de SRID 4326.

Compatibilidad:
    * **Producción / Docker:** PostgreSQL + PostGIS vía ``geoalchemy2``.
    * **Desarrollo / pruebas:** cualquier dialecto soportado por SQLAlchemy
      (por ejemplo SQLite) guardando la geometría como GeoJSON en texto.

La clase :class:`Geometry` es un ``TypeDecorator`` que resuelve el tipo real
según el dialecto. A nivel de aplicación las geometrías siempre se leen y
escriben como diccionarios **GeoJSON**, independientemente del motor.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from dotenv import load_dotenv
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    TypeDecorator,
    create_engine,
    text,
)
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.types import Text as SQLText

load_dotenv()

# --------------------------------------------------------------------------- #
# Dependencias espaciales opcionales
# --------------------------------------------------------------------------- #
try:  # pragma: no cover - depende del entorno de despliegue
    from geoalchemy2 import Geometry as _PostGISGeometry

    HAS_GEOALCHEMY = True
except Exception:  # pragma: no cover
    _PostGISGeometry = None  # type: ignore[assignment]
    HAS_GEOALCHEMY = False

try:  # pragma: no cover - depende del entorno de despliegue
    from shapely import wkb as _shapely_wkb
    from shapely import wkt as _shapely_wkt
    from shapely.geometry import mapping as _shapely_mapping
    from shapely.geometry import shape as _shapely_shape

    HAS_SHAPELY = True
except Exception:  # pragma: no cover
    HAS_SHAPELY = False


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def utcnow() -> datetime:
    """Timestamp UTC *aware* (reemplaza al obsoleto ``datetime.utcnow``)."""

    return datetime.now(timezone.utc)


def _a_geojson(valor):
    """Normaliza una entrada geométrica (GeoJSON / WKT / WKB) a un dict GeoJSON."""

    if valor is None:
        return None
    if isinstance(valor, dict):
        if "type" not in valor:
            raise ValueError("Geometría inválida: falta la clave 'type'")
        return valor
    if HAS_SHAPELY:
        if isinstance(valor, (bytes, bytearray, memoryview)):
            return _shapely_mapping(_shapely_wkb.loads(bytes(valor)))
        if isinstance(valor, str):
            texto = valor.strip()
            if texto.startswith("{"):
                return json.loads(texto)
            return _shapely_mapping(_shapely_wkt.loads(texto))
    if isinstance(valor, str):
        texto = valor.strip()
        if texto.startswith("{"):
            return json.loads(texto)
        # Sin shapely sólo podemos conservar el WKT tal cual.
        return {"type": "WKT", "wkt": texto}
    raise TypeError(f"Tipo de geometría no soportado: {type(valor)!r}")


def _geojson_a_ewkt(geo: dict, srid: int) -> str:
    """Convierte un dict GeoJSON en EWKT para PostGIS."""

    if not HAS_SHAPELY:  # pragma: no cover - shapely es requisito en PostGIS
        raise RuntimeError("Se requiere 'shapely' para escribir geometrías en PostGIS")
    return f"SRID={srid};{_shapely_shape(geo).wkt}"


# --------------------------------------------------------------------------- #
# Tipo espacial portable
# --------------------------------------------------------------------------- #
class Geometry(TypeDecorator):
    """Columna espacial portable.

    En PostgreSQL delega a ``geoalchemy2.Geometry`` (activando el índice GiST
    y el tipo ``geometry(POINT, 4326)`` de PostGIS). En cualquier otro motor
    almacena el GeoJSON serializado en una columna ``TEXT``.
    """

    impl = SQLText
    cache_ok = True

    def __init__(self, geometry_type: str = "POINT", srid: int = 4326, **kwargs):
        self.geometry_type = geometry_type.upper()
        self.srid = srid
        super().__init__(**kwargs)

    # -- DDL / tipo real por dialecto -------------------------------------- #
    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql" and HAS_GEOALCHEMY:
            return dialect.type_descriptor(
                _PostGISGeometry(self.geometry_type, srid=self.srid)
            )
        return dialect.type_descriptor(SQLText())

    # -- Python -> DB ------------------------------------------------------ #
    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        geo = _a_geojson(value)
        if dialect.name == "postgresql" and HAS_GEOALCHEMY:
            if geo.get("type") == "WKT":
                return f"SRID={self.srid};{geo['wkt']}"
            return _geojson_a_ewkt(geo, self.srid)
        if geo.get("type") == "WKT":
            return geo["wkt"]
        return json.dumps(geo, separators=(",", ":"))

    # -- DB -> Python ------------------------------------------------------ #
    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if not isinstance(value, (str, bytes, bytearray, memoryview, dict)):
            # ``WKBElement`` devuelto por geoalchemy2.
            try:  # pragma: no cover - sólo PostGIS
                from geoalchemy2.shape import to_shape

                return _shapely_mapping(to_shape(value))
            except Exception:  # pragma: no cover
                value = bytes(value.data)  # type: ignore[attr-defined]
        return _a_geojson(value)


# --------------------------------------------------------------------------- #
# Configuración de conexión
# --------------------------------------------------------------------------- #
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    f"sqlite:///{os.path.join(BASE_DIR, 'mesh_resq.db')}",
)

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    future=True,
    pool_pre_ping=True,
    connect_args=_connect_args,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


# --------------------------------------------------------------------------- #
# Modelos
# --------------------------------------------------------------------------- #
class PosicionRescatista(Base):
    __tablename__ = "posiciones_rescatistas"

    id = Column(Integer, primary_key=True, index=True)
    rescatista_id = Column(String, index=True)
    cuadrilla = Column(String, index=True)
    ubicacion = Column(Geometry("POINT", srid=4326))
    altitud = Column(Float, nullable=True)
    precision_m = Column(Float)
    timestamp = Column(DateTime(timezone=True), default=utcnow, index=True)

    def a_geojson(self) -> dict:
        return {
            "type": "Feature",
            "geometry": self.ubicacion,
            "properties": {
                "capa": "posiciones",
                "id": self.id,
                "rescatista_id": self.rescatista_id,
                "cuadrilla": self.cuadrilla,
                "altitud": self.altitud,
                "precision_m": self.precision_m,
                "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            },
        }


class ZonaPeinada(Base):
    __tablename__ = "zonas_peinadas"

    id = Column(Integer, primary_key=True, index=True)
    cuadrilla_id = Column(String, index=True)
    poligono = Column(Geometry("POLYGON", srid=4326))
    observaciones = Column(Text, nullable=True)
    timestamp = Column(DateTime(timezone=True), default=utcnow, index=True)

    def a_geojson(self) -> dict:
        return {
            "type": "Feature",
            "geometry": self.poligono,
            "properties": {
                "capa": "zonas_peinadas",
                "id": self.id,
                "cuadrilla_id": self.cuadrilla_id,
                "observaciones": self.observaciones,
                "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            },
        }


class ReporteRiesgo(Base):
    __tablename__ = "reportes_riesgo"

    id = Column(Integer, primary_key=True, index=True)
    tipo_riesgo = Column(String, index=True)  # Colapso, Fuga de Gas, Incendio...
    nivel_gravedad = Column(Integer)  # 1 (Bajo) .. 5 (Crítico)
    ubicacion = Column(Geometry("POINT", srid=4326))
    radio_afectacion_m = Column(Float, default=10.0)
    descripcion = Column(Text, nullable=True)
    atendido = Column(Boolean, default=False)
    timestamp = Column(DateTime(timezone=True), default=utcnow, index=True)

    def a_geojson(self) -> dict:
        return {
            "type": "Feature",
            "geometry": self.ubicacion,
            "properties": {
                "capa": "riesgos",
                "id": self.id,
                "tipo_riesgo": self.tipo_riesgo,
                "nivel_gravedad": self.nivel_gravedad,
                "radio_afectacion_m": self.radio_afectacion_m,
                "descripcion": self.descripcion,
                "atendido": self.atendido,
                "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            },
        }


class BloqueoVial(Base):
    __tablename__ = "bloqueos_viales"

    id = Column(Integer, primary_key=True, index=True)
    tipo_obstaculo = Column(String, index=True)  # ESCOMBROS, ARBOL_CAIDO...
    ubicacion = Column(Geometry("POINT", srid=4326))
    radio_bloqueo_m = Column(Float, default=15.0)
    descripcion = Column(Text, nullable=True)
    activo = Column(Boolean, default=True, index=True)
    timestamp = Column(DateTime(timezone=True), default=utcnow, index=True)

    def a_geojson(self) -> dict:
        return {
            "type": "Feature",
            "geometry": self.ubicacion,
            "properties": {
                "capa": "bloqueos",
                "id": self.id,
                "tipo_obstaculo": self.tipo_obstaculo,
                "radio_bloqueo_m": self.radio_bloqueo_m,
                "descripcion": self.descripcion,
                "activo": self.activo,
                "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            },
        }


# --------------------------------------------------------------------------- #
# Ciclo de vida de la base de datos
# --------------------------------------------------------------------------- #
def init_db() -> None:
    """Crea la extensión PostGIS (si aplica) y todas las tablas."""

    if engine.dialect.name == "postgresql":
        with engine.begin() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    Base.metadata.create_all(bind=engine)


def get_db():
    """Dependencia de FastAPI que entrega una sesión por petición."""

    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
