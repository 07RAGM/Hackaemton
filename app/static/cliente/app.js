/**
 * Mesh-ResQ GNSS — Cliente de Campo (PWA)
 * ---------------------------------------------------------------------------
 * * Captura continua de telemetría GNSS con `watchPosition` (alta precisión).
 * * Reportes de bloqueos viales, riesgos y zonas peinadas.
 * * Persistencia local en IndexedDB cuando no hay enlace con el nodo mesh.
 * * Sincronización automática por heartbeat + evento `online`.
 */
'use strict';

const API = '';                       // mismo origen que sirve la PWA
const NOMBRE_DB = 'meshresq';
const ALMACEN = 'cola';
const CLAVE_RESCATISTA = 'meshresq.rescatista';
const CLAVE_CUADRILLA = 'meshresq.cuadrilla';
const MAX_PUNTOS_POR_LOTE = 5;        // criterio de aceptación n.º 1
const INTERVALO_LOTE_MS = 30000;
const INTERVALO_HEARTBEAT_MS = 15000;

// Configuración y estado del mini-mapa para reportar bloqueos.
const CLAVE_CONFIG = 'meshresq.config';
const CENTRO_POR_DEFECTO = { lat: 19.0433, lon: -98.1987 };
let configMapa = {
  centro: CENTRO_POR_DEFECTO,
  tiles_url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
  tiles_atribucion: '© OpenStreetMap contributors',
};
let mapaBloqueo = null;
let marcadorBloqueo = null;
let marcadorGps = null;

// --------------------------------------------------------------------------
// Estado en memoria
// --------------------------------------------------------------------------
const estado = {
  posicion: null,          // última posición GNSS
  buffer: [],              // puntos pendientes de empaquetar en un lote
  ultimoLote: 0,           // instante del último flush de telemetría
  peinando: false,
  recorrido: [],           // acumulador de puntos del polígono peinado
  enlace: false,           // heartbeat contra el nodo mesh
  sincronizando: false,
  puntoBloqueo: null,      // punto elegido en el mapa para el bloqueo
};

const rescatistaId = (() => {
  let id = localStorage.getItem(CLAVE_RESCATISTA);
  if (!id) {
    id = 'R-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    localStorage.setItem(CLAVE_RESCATISTA, id);
  }
  return id;
})();
const cuadrilla = localStorage.getItem(CLAVE_CUADRILLA) || 'CUADRILLA-1';

// --------------------------------------------------------------------------
// Utilidades de interfaz
// --------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
let temporizadorToast = null;

function toast(mensaje, tipo = '') {
  const t = $('toast');
  t.textContent = mensaje;
  t.className = tipo ? `ver ${tipo}` : 'ver';
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => (t.className = ''), 3200);
}

function fijarLed(id, clase) {
  $(id).className = 'led ' + clase;
}

function actualizarCabecera() {
  $('txt-id').textContent = rescatistaId;
  fijarLed('led-red', estado.enlace ? 'ok' : 'bad');
  $('txt-red').textContent = estado.enlace
    ? 'MESH OK'
    : (navigator.onLine ? 'sin nodo' : 'OFFLINE');
}

// --------------------------------------------------------------------------
// IndexedDB
// --------------------------------------------------------------------------
let db = null;

function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOMBRE_DB, 1);
    req.onupgradeneeded = () => {
      const base = req.result;
      if (!base.objectStoreNames.contains(ALMACEN)) {
        const store = base.createObjectStore(ALMACEN, { keyPath: 'id', autoIncrement: true });
        store.createIndex('tipo', 'tipo', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(modo = 'readonly') {
  return db.transaction(ALMACEN, modo).objectStore(ALMACEN);
}

function encolar(tipo, payload) {
  return new Promise((resolve, reject) => {
    const registro = { tipo, payload, creado: new Date().toISOString() };
    const req = tx('readwrite').add(registro);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function leerCola() {
  return new Promise((resolve, reject) => {
    const req = tx().getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function borrarDeCola(id) {
  return new Promise((resolve, reject) => {
    const req = tx('readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function refrescarColaUI() {
  const cola = await leerCola();
  $('txt-cola').textContent = cola.length;
  const lista = $('lista-cola');
  if (!cola.length) {
    lista.innerHTML = '<li class="vacio">Sin elementos pendientes</li>';
    return;
  }
  lista.innerHTML = cola
    .slice(-8)
    .reverse()
    .map((r) => {
      const hora = new Date(r.creado).toLocaleTimeString();
      const detalle =
        r.tipo === 'telemetria'
          ? `${r.payload.puntos.length} pts`
          : r.tipo === 'zona_peinada'
          ? `${r.payload.recorrido.length} pts`
          : r.payload.tipo_obstaculo || r.payload.tipo_riesgo || '';
      return `<li><span>${r.tipo.toUpperCase()} · ${detalle}</span><span>${hora}</span></li>`;
    })
    .join('');
}

// --------------------------------------------------------------------------
// Sincronización
// --------------------------------------------------------------------------
const RUTAS_POR_TIPO = {
  telemetria: () => `${API}/api/telemetria/batch`,
  bloqueo: () => `${API}/api/bloqueos/`,
  riesgo: () => `${API}/api/riesgos/`,
  zona_peinada: () => `${API}/api/zonas-peinadas/`,
};

async function sincronizar(silencioso = false) {
  if (estado.sincronizando) return;
  if (!navigator.onLine) {
    if (!silencioso) toast('Sin enlace de red: datos guardados localmente', 'err');
    return;
  }
  estado.sincronizando = true;
  let enviados = 0;
  try {
    const cola = await leerCola();
    for (const registro of cola) {
      const url = (RUTAS_POR_TIPO[registro.tipo] || (() => null))();
      if (!url) {
        await borrarDeCola(registro.id);
        continue;
      }
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(registro.payload),
          signal: AbortSignal.timeout(8000),
        });
        if (resp.ok) {
          await borrarDeCola(registro.id);
          enviados += 1;
        } else if (resp.status >= 400 && resp.status < 500) {
          // Payload inválido: no tiene sentido reintentar para siempre.
          console.warn('Descartando registro inválido', registro.tipo, await resp.text());
          await borrarDeCola(registro.id);
        }
      } catch (err) {
        console.warn('Fallo al sincronizar', registro.tipo, err);
        break; // el nodo mesh no responde: reintentar en el próximo heartbeat
      }
    }
  } finally {
    estado.sincronizando = false;
    await refrescarColaUI();
    if (enviados && !silencioso) toast(`${enviados} registro(s) sincronizado(s)`, 'ok');
  }
}

async function heartbeat() {
  try {
    const resp = await fetch(`${API}/health`, { signal: AbortSignal.timeout(4000) });
    estado.enlace = resp.ok;
  } catch (_) {
    estado.enlace = false;
  }
  actualizarCabecera();
  if (estado.enlace) sincronizar(true);
}

// --------------------------------------------------------------------------
// Telemetría GNSS
// --------------------------------------------------------------------------
function actualizarUIposicion(pos) {
  const c = pos.coords;
  $('txt-lat').textContent = c.latitude.toFixed(6);
  $('txt-lon').textContent = c.longitude.toFixed(6);
  $('txt-alt').textContent = c.altitude != null ? c.altitude.toFixed(1) : '—';
  $('txt-prec').textContent = c.accuracy != null ? c.accuracy.toFixed(1) : '—';
}

function envolverPunto(pos) {
  const c = pos.coords;
  return {
    lat: c.latitude,
    lon: c.longitude,
    altitud: c.altitude,
    precision_m: c.accuracy,
    velocidad_m_s: c.speed,
    timestamp: new Date(pos.timestamp || Date.now()).toISOString(),
    rescatista_id: rescatistaId,
    cuadrilla,
  };
}

function puntoActual() {
  return estado.posicion ? envolverPunto(estado.posicion) : null;
}

async function vaciarBuffer(ahora = false) {
  if (!estado.buffer.length) return;
  if (!ahora && estado.buffer.length < MAX_PUNTOS_POR_LOTE) return;
  const puntos = estado.buffer.splice(0, estado.buffer.length);
  estado.ultimoLote = Date.now();
  await encolar('telemetria', { rescatista_id: rescatistaId, cuadrilla, puntos });
  await refrescarColaUI();
  sincronizar(true);
}

function iniciarGPS() {
  if (!('geolocation' in navigator)) {
    fijarLed('led-gps', 'bad');
    $('txt-gps').textContent = 'no soportado';
    return;
  }
  fijarLed('led-gps', 'warn');
  $('txt-gps').textContent = 'buscando…';

  navigator.geolocation.watchPosition(
    async (pos) => {
      estado.posicion = pos;
      fijarLed('led-gps', 'ok');
      $('txt-gps').textContent = 'activo';
      actualizarUIposicion(pos);
      actualizarMarcadorGps();

      const punto = envolverPunto(pos);
      estado.buffer.push(punto);
      if (estado.peinando) {
        // Trazado continuo para la zona peinada (capa verde del dashboard).
        estado.recorrido.push([punto.lon, punto.lat]);
        $('lbl-peinado').textContent = `Peinando (${estado.recorrido.length} pts)`;
      }
      if (estado.buffer.length >= MAX_PUNTOS_POR_LOTE) await vaciarBuffer(true);
    },
    (err) => {
      fijarLed('led-gps', 'bad');
      $('txt-gps').textContent = err.code === 1 ? 'denegado' : 'sin señal';
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
  );
}

// --------------------------------------------------------------------------
// Selector de punto para bloqueos (mini-mapa Leaflet)
// --------------------------------------------------------------------------
function centroMapa() {
  const c = configMapa.centro;
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
    return { lat: c.lat, lon: c.lon };
  }
  return CENTRO_POR_DEFECTO;
}

function leerConfigGuardada() {
  try {
    const guardada = JSON.parse(localStorage.getItem(CLAVE_CONFIG) || 'null');
    if (guardada && typeof guardada === 'object') {
      configMapa = { ...configMapa, ...guardada };
      configMapa.centro = centroMapa();
    }
  } catch (_) {
    /* Configuración local corrupta: se usa el valor por defecto. */
  }
}

async function cargarConfigMapa() {
  leerConfigGuardada();
  try {
    const resp = await fetch(`${API}/api/config`, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return;
    const cfg = await resp.json();
    const centro = cfg.centro;
    if (centro && Number.isFinite(centro.lat) && Number.isFinite(centro.lon)) {
      configMapa.centro = { lat: centro.lat, lon: centro.lon };
    }
    configMapa.tiles_url = cfg.tiles_url || null;
    configMapa.tiles_atribucion = cfg.tiles_atribucion || '';
    configMapa.tiles_local = !!cfg.tiles_local;
    configMapa.tiles_min_zoom = cfg.tiles_min_zoom;
    configMapa.tiles_max_zoom = cfg.tiles_max_zoom;
    configMapa.tiles_bounds = cfg.tiles_bounds;
    configMapa.tiles_oscuras = !!cfg.tiles_oscuras;
    try {
      localStorage.setItem(
        CLAVE_CONFIG,
        JSON.stringify({
          centro: configMapa.centro,
          tiles_url: configMapa.tiles_url,
          tiles_atribucion: configMapa.tiles_atribucion,
          tiles_local: configMapa.tiles_local,
          tiles_min_zoom: configMapa.tiles_min_zoom,
          tiles_max_zoom: configMapa.tiles_max_zoom,
          tiles_bounds: configMapa.tiles_bounds,
          tiles_oscuras: configMapa.tiles_oscuras,
        })
      );
    } catch (_) {
      /* localStorage lleno o bloqueado. */
    }
  } catch (_) {
    /* Sin nodo mesh: se usa la última configuración guardada. */
  }
}

function iconoPinBloqueo() {
  return L.divIcon({
    className: 'pin-bloqueo',
    html: '<span></span>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function pintarPuntoBloqueo(origen = 'mapa') {
  const p = estado.puntoBloqueo;
  if (!p) {
    $('txt-punto-bloqueo').textContent = 'Toca el mapa para fijar el punto del bloqueo.';
    return;
  }
  const etiqueta = origen === 'GPS' ? 'GPS actual' : 'seleccionado en el mapa';
  $('txt-punto-bloqueo').innerHTML =
    `Punto <b>${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</b><br>${etiqueta}`;
}

function fijarPuntoBloqueo(lat, lon, origen = 'mapa') {
  estado.puntoBloqueo = {
    lat,
    lon,
    origen,
    timestamp: new Date().toISOString(),
  };
  if (!mapaBloqueo) return pintarPuntoBloqueo(origen);

  if (!marcadorBloqueo) {
    marcadorBloqueo = L.marker([lat, lon], {
      icon: iconoPinBloqueo(),
      draggable: true,
      autoPan: true,
      title: 'Punto del bloqueo',
      zIndexOffset: 800,
    }).addTo(mapaBloqueo);
    marcadorBloqueo.on('dragend', () => {
      const ll = marcadorBloqueo.getLatLng();
      estado.puntoBloqueo = {
        lat: ll.lat,
        lon: ll.lng,
        origen: 'mapa',
        timestamp: new Date().toISOString(),
      };
      pintarPuntoBloqueo('mapa');
    });
  } else {
    marcadorBloqueo.setLatLng([lat, lon]);
  }
  mapaBloqueo.panTo([lat, lon], { animate: false });
  pintarPuntoBloqueo(origen);
}

function actualizarMarcadorGps() {
  if (!mapaBloqueo || !estado.posicion) return;
  const { latitude, longitude } = estado.posicion.coords;
  if (!marcadorGps) {
    marcadorGps = L.marker([latitude, longitude], {
      icon: L.divIcon({
        className: 'gps-campo',
        html: '<span></span>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
      interactive: false,
      zIndexOffset: 500,
    }).addTo(mapaBloqueo);
  } else {
    marcadorGps.setLatLng([latitude, longitude]);
  }
}

function crearMapaBloqueo() {
  if (mapaBloqueo) return mapaBloqueo;

  const contenedor = $('mapa-bloqueo');
  if (typeof L === 'undefined') {
    contenedor.innerHTML =
      '<div class="mapa-fallback">Mapa no disponible. Usa «Mi GPS» para reportar tu posición actual.</div>';
    return null;
  }

  const actual = puntoActual();
  const centro = actual
    ? [actual.lat, actual.lon]
    : [centroMapa().lat, centroMapa().lon];

  mapaBloqueo = L.map(contenedor, {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
  }).setView(centro, 16);

  if (typeof configMapa.tiles_url === 'string' && configMapa.tiles_url) {
    const opciones = {
      maxZoom: 19,
      attribution: configMapa.tiles_atribucion || '',
    };
    if (configMapa.tiles_min_zoom) {
      opciones.minNativeZoom = configMapa.tiles_min_zoom;
    }
    if (configMapa.tiles_max_zoom) {
      opciones.maxNativeZoom = configMapa.tiles_max_zoom;
    }
    if (
      Array.isArray(configMapa.tiles_bounds) &&
      configMapa.tiles_bounds.length === 4
    ) {
      const [sur, oeste, norte, este] = configMapa.tiles_bounds;
      opciones.bounds = L.latLngBounds([sur, oeste], [norte, este]);
    }
    const capa = L.tileLayer(configMapa.tiles_url, opciones).addTo(mapaBloqueo);
    if (configMapa.tiles_oscuras) {
      const contenedorTeselas = capa.getContainer();
      if (contenedorTeselas) contenedorTeselas.classList.add('teselas-oscuras');
    }
  }

  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(mapaBloqueo);

  mapaBloqueo.on('click', (ev) => {
    fijarPuntoBloqueo(ev.latlng.lat, ev.latlng.lng, 'mapa');
  });

  actualizarMarcadorGps();
  return mapaBloqueo;
}

function abrirDlgBloqueo() {
  estado.puntoBloqueo = null;
  if (marcadorBloqueo) {
    marcadorBloqueo.remove();
    marcadorBloqueo = null;
  }
  $('dlg-bloqueo').showModal();
  crearMapaBloqueo();

  // El diálogo aún no tiene su tamaño final al abrirse: se recalcula y se
  // parte de la posición GPS actual (si ya hay fix).
  setTimeout(() => {
    if (!mapaBloqueo) return;
    mapaBloqueo.invalidateSize();
    const actual = puntoActual();
    if (actual) {
      fijarPuntoBloqueo(actual.lat, actual.lon, 'GPS');
      mapaBloqueo.setView([actual.lat, actual.lon], 16);
    } else {
      const c = centroMapa();
      mapaBloqueo.setView([c.lat, c.lon], 15);
      pintarPuntoBloqueo();
    }
    actualizarMarcadorGps();
  }, 120);
}

function usarGpsBloqueo() {
  const actual = puntoActual();
  if (!actual) return toast('Esperando señal GPS…', 'err');
  crearMapaBloqueo();
  fijarPuntoBloqueo(actual.lat, actual.lon, 'GPS');
  if (mapaBloqueo) mapaBloqueo.setView([actual.lat, actual.lon], 16);
  actualizarMarcadorGps();
}

// --------------------------------------------------------------------------
// Reportes
// --------------------------------------------------------------------------
async function registrarBloqueo() {
  const punto = estado.puntoBloqueo || puntoActual();
  if (!punto) return toast('Selecciona un punto en el mapa o espera al GPS', 'err');
  const payload = {
    tipo_obstaculo: $('obstaculo').value,
    lat: punto.lat,
    lon: punto.lon,
    radio_bloqueo_m: Number($('radio-bloqueo').value) || 15,
    descripcion: $('desc-bloqueo').value || null,
    timestamp: punto.timestamp || new Date().toISOString(),
    rescatista_id: rescatistaId,
  };
  await encolar('bloqueo', payload);
  await refrescarColaUI();
  estado.puntoBloqueo = null;
  toast('Bloqueo guardado en la cola local', 'ok');
  sincronizar(true);
}

async function registrarRiesgo() {
  const punto = puntoActual();
  if (!punto) return toast('Esperando señal GPS…', 'err');
  const payload = {
    tipo_riesgo: $('tipo-riesgo').value,
    nivel_gravedad: Number($('gravedad').value) || 3,
    lat: punto.lat,
    lon: punto.lon,
    radio_afectacion_m: Number($('radio-riesgo').value) || 25,
    descripcion: $('desc-riesgo').value || null,
    timestamp: punto.timestamp,
  };
  await encolar('riesgo', payload);
  await refrescarColaUI();
  toast('Riesgo guardado en la cola local', 'ok');
  sincronizar(true);
}

async function alternarPeinado() {
  if (!estado.peinando) {
    estado.peinando = true;
    estado.recorrido = [];
    $('btn-peinado').classList.add('activo');
    $('lbl-peinado').textContent = 'Peinando (0 pts)';
    toast('Grabando zona peinada…');
    return;
  }
  estado.peinando = false;
  $('btn-peinado').classList.remove('activo');
  $('lbl-peinado').textContent = 'Iniciar zona peinada';
  if (estado.recorrido.length < 2) {
    toast('Recorrido demasiado corto, descartado', 'err');
    return;
  }
  await encolar('zona_peinada', {
    cuadrilla_id: cuadrilla,
    recorrido: estado.recorrido,
    radio_m: 25,
    observaciones: `Zona peinada por ${rescatistaId}`,
    timestamp: new Date().toISOString(),
  });
  const n = estado.recorrido.length;
  estado.recorrido = [];
  await refrescarColaUI();
  toast(`Zona peinada guardada (${n} puntos)`, 'ok');
  sincronizar(true);
}

// --------------------------------------------------------------------------
// Arranque
// --------------------------------------------------------------------------
function conectarEventos() {
  $('btn-bloqueo').addEventListener('click', abrirDlgBloqueo);
  $('btn-gps-bloqueo').addEventListener('click', usarGpsBloqueo);
  $('btn-riesgo').addEventListener('click', () => $('dlg-riesgo').showModal());
  $('btn-peinado').addEventListener('click', alternarPeinado);
  $('btn-sincronizar').addEventListener('click', () => sincronizar(false));
  $('btn-sync-flotante').addEventListener('click', () => sincronizar(false));
  $('btn-punto').addEventListener('click', async () => {
    await vaciarBuffer(true);
    toast('Punto GNSS encolado', 'ok');
  });

  $('dlg-bloqueo').addEventListener('close', (ev) => {
    if (ev.target.returnValue === 'enviar') registrarBloqueo();
  });
  $('dlg-riesgo').addEventListener('close', (ev) => {
    if (ev.target.returnValue === 'enviar') registrarRiesgo();
  });

  window.addEventListener('online', () => {
    toast('Red recuperada, sincronizando…', 'ok');
    heartbeat();
  });
  window.addEventListener('offline', () => {
    estado.enlace = false;
    actualizarCabecera();
    toast('Sin red: trabajando en modo local', 'err');
  });
}

async function iniciar() {
  actualizarCabecera();
  cargarConfigMapa();
  try {
    db = await abrirDB();
  } catch (err) {
    console.error('IndexedDB no disponible', err);
    toast('IndexedDB no disponible en este navegador', 'err');
  }
  conectarEventos();
  iniciarGPS();
  await refrescarColaUI();
  heartbeat();

  setInterval(heartbeat, INTERVALO_HEARTBEAT_MS);
  setInterval(() => vaciarBuffer(false), INTERVALO_LOTE_MS);
  setInterval(() => vaciarBuffer(true), INTERVALO_LOTE_MS * 2);

  if ('serviceWorker' in navigator) {
    // Scope acotado a /cliente/ para no interferir con el dashboard de control.
    navigator.serviceWorker.register('/sw.js', { scope: '/cliente/' }).catch((e) => console.warn('SW', e));
  }
}

document.addEventListener('DOMContentLoaded', iniciar);
