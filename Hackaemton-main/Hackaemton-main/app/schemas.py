"""Esquemas Pydantic (request/response) de la API Mesh-ResQ GNSS."""

from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Tipos de obstáculo aceptados (el cliente los usa en el formulario rápido)
TIPOS_OBSTACULO = ("ESCOMBROS", "ARBOL_CAIDO", "DERRUMBE", "INUNDACION", "OTRO")
TIPOS_RIESGO = (
    "COLAPSO",
    "FUGA_GAS",
    "INCENDIO",
    "QUIMICO",
    "ELECTRICO",
    "INUNDACION",
    "OTRO",
)


class PuntoGNSS(BaseModel):
    """Muestra de telemetría capturada por el rescatista."""

    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    altitud: Optional[float] = None
    precision_m: Optional[float] = Field(None, ge=0)
    velocidad_m_s: Optional[float] = Field(None, ge=0)
    timestamp: Optional[datetime] = None
    rescatista_id: Optional[str] = None
    cuadrilla: Optional[str] = None


class TelemetriaBatch(BaseModel):
    """Lote de puntos GNSS acumulados offline (endpoint de sincronización)."""

    rescatista_id: str
    cuadrilla: Optional[str] = None
    puntos: List[PuntoGNSS] = Field(default_factory=list)

    @field_validator("puntos")
    @classmethod
    def _no_vacio(cls, v):
        if not v:
            raise ValueError("El lote de telemetría no puede estar vacío")
        return v


class ReporteRiesgoIn(BaseModel):
    tipo_riesgo: str
    nivel_gravedad: int = Field(3, ge=1, le=5)
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    radio_afectacion_m: float = Field(10.0, gt=0, le=5000)
    descripcion: Optional[str] = None
    timestamp: Optional[datetime] = None

    @field_validator("tipo_riesgo")
    @classmethod
    def _normaliza(cls, v: str) -> str:
        return v.strip().upper().replace(" ", "_")


class ZonaPeinadaIn(BaseModel):
    """Zona peinada: polígono explícito o recorrido a bufferizar."""

    cuadrilla_id: str
    poligono: Optional[Dict] = None
    recorrido: Optional[List[List[float]]] = None  # [[lon, lat], ...]
    radio_m: float = Field(25.0, gt=0, le=2000)
    observaciones: Optional[str] = None
    timestamp: Optional[datetime] = None

    @field_validator("poligono")
    @classmethod
    def _valida_poligono(cls, v):
        if v is not None and v.get("type") not in ("Polygon", "MultiPolygon"):
            raise ValueError("El polígono debe ser GeoJSON Polygon/MultiPolygon")
        return v


class BloqueoVialIn(BaseModel):
    tipo_obstaculo: str = "ESCOMBROS"
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    radio_bloqueo_m: float = Field(15.0, gt=0, le=2000)
    descripcion: Optional[str] = None
    timestamp: Optional[datetime] = None
    rescatista_id: Optional[str] = None

    @field_validator("tipo_obstaculo")
    @classmethod
    def _normaliza(cls, v: str) -> str:
        return v.strip().upper().replace(" ", "_")


class BloqueoEstadoIn(BaseModel):
    activo: bool = False


class RutaOptimaOut(BaseModel):
    distancia_m: float
    duracion_s: float
    velocidad_m_s: float
    nodos: int
    coordenadas: List[List[float]]
    origen_ajustado: List
    destino_ajustado: List
    geojson: Dict
    bloqueos_esquivados: int = 0


class RespuestaOperacion(BaseModel):
    model_config = ConfigDict(extra="allow")

    ok: bool = True
    mensaje: str = ""
