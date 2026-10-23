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
// Reportes
// --------------------------------------------------------------------------
async function registrarBloqueo() {
  const punto = puntoActual();
  if (!punto) return toast('Esperando señal GPS…', 'err');
  const payload = {
    tipo_obstaculo: $('obstaculo').value,
    lat: punto.lat,
    lon: punto.lon,
    radio_bloqueo_m: Number($('radio-bloqueo').value) || 15,
    descripcion: $('desc-bloqueo').value || null,
    timestamp: punto.timestamp,
    rescatista_id: rescatistaId,
  };
  await encolar('bloqueo', payload);
  await refrescarColaUI();
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
  $('btn-bloqueo').addEventListener('click', () => $('dlg-bloqueo').showModal());
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
