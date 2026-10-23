/**
 * Mesh-ResQ GNSS — Estación de Control (dashboard táctico).
 * ---------------------------------------------------------------------------
 * * Fondo de mapa táctico generado localmente (canvas, sin API keys ni red).
 *   Si el backend expone `MESH_RESQ_TILES_URL`, se usa esa fuente de teselas.
 * * Capas en vivo: posiciones, zonas peinadas, riesgos y bloqueos viales.
 * * Ruteo óptimo con Dijkstra, recalculado al recibir un bloqueo por WebSocket.
 */
'use strict';

const API = '';
const CAPAS = {};
const marcadoresRescate = new Map();
const marcadoresBloqueo = new Map();
const marcadoresRiesgo = new Map();
const zonasDibujadas = new Set();

let mapa = null;
let rutaLinea = null;
let marcadorOrigen = null;
let marcadorDestino = null;
let origen = null;
let destino = null;
let modoPunto = null;
let primeraCarga = true;
let centroConfig = { lat: 19.0433, lon: -98.1987 };

const $ = (id) => document.getElementById(id);

const CAPAS_UI = [
  ['chk-bloqueos', 'bloqueos'],
  ['chk-riesgos', 'riesgos'],
  ['chk-zonas', 'zonas'],
  ['chk-posiciones', 'posiciones'],
];

const PRESETS = {
  tactico: ['bloqueos', 'riesgos', 'zonas', 'posiciones'],
  rescate: ['riesgos', 'zonas', 'posiciones'],
  ruta: ['bloqueos', 'posiciones'],
};

// --------------------------------------------------------------------------
// Utilidades
// --------------------------------------------------------------------------
function log(texto, clase = '') {
  const caja = $('log');
  const ev = document.createElement('div');
  ev.className = 'ev ' + clase;
  ev.innerHTML = `<b>${texto}</b><time>${new Date().toLocaleTimeString()}</time>`;
  caja.prepend(ev);
  while (caja.children.length > 40) caja.removeChild(caja.lastChild);
}

function led(id, estado) { $(id).className = 'led ' + estado; }

function marcarBanner(estado) {
  const b = $('banner');
  const t = $('banner-txt');
  b.className = 'banner';
  if (estado === 'ok') {
    b.textContent = 'EN VIVO';
    t.textContent = 'Nodo mesh conectado · datos en tiempo real';
  } else if (estado === 'warn') {
    b.classList.add('warn');
    b.textContent = 'RECONECTANDO';
    t.textContent = 'Enlace en vivo interrumpido · reintentando conexión';
  } else {
    b.classList.add('bad');
    b.textContent = 'SIN ENLACE';
    t.textContent = 'No se pudo contactar al nodo · mostrando datos locales';
  }
}

function marcarNodo(estado, texto) {
  const el = $('nodo-estado');
  if (!el) return;
  el.className = `mini-status ${estado}`;
  el.innerHTML = `<span class="dot"></span> ${texto}`;
}

function popup(titulo, filas) {
  const cuerpo = filas
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div><b>${k}:</b> ${v}</div>`)
    .join('');
  return `<div style="min-width:170px"><div style="font-weight:600;margin-bottom:7px">${titulo}</div>${cuerpo}</div>`;
}

// --------------------------------------------------------------------------
// Fondo de mapa táctico (canvas, 100 % local)
// --------------------------------------------------------------------------
const FondoTactico = L.GridLayer.extend({
  createTile(coords) {
    const size = this.getTileSize();
    const tile = L.DomUtil.create('canvas', 'leaflet-tile');
    tile.width = size.x;
    tile.height = size.y;
    const ctx = tile.getContext('2d');

    ctx.fillStyle = '#070707';
    ctx.fillRect(0, 0, size.x, size.y);

    // Retícula fina.
    ctx.strokeStyle = 'rgba(154,154,154,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 8; i++) {
      const p = Math.round((i * size.x) / 8) + 0.5;
      ctx.moveTo(p, 0); ctx.lineTo(p, size.y);
      ctx.moveTo(0, p); ctx.lineTo(size.x, p);
    }
    ctx.stroke();

    // Retícula mayor cada 4 celdas, con acento.
    ctx.strokeStyle = 'rgba(214,242,74,0.14)';
    ctx.beginPath();
    for (let i = 2; i < 8; i += 4) {
      const p = Math.round((i * size.x) / 8) + 0.5;
      ctx.moveTo(p, 0); ctx.lineTo(p, size.y);
      ctx.moveTo(0, p); ctx.lineTo(size.x, p);
    }
    ctx.stroke();

    // Nodos en las intersecciones mayores.
    ctx.fillStyle = 'rgba(214,242,74,0.38)';
    for (const x of [0.25, 0.75]) {
      for (const y of [0.25, 0.75]) {
        ctx.beginPath();
        ctx.arc(x * size.x, y * size.y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const nw = this._tileCoordsToBounds(coords).getNorthWest();
    ctx.fillStyle = 'rgba(154,154,154,0.55)';
    ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(`${nw.lat.toFixed(4)}  ${nw.lng.toFixed(4)}`, 8, 16);

    return tile;
  },
});

// --------------------------------------------------------------------------
// Inicialización del mapa
// --------------------------------------------------------------------------
async function iniciarMapa() {
  let config = { centro: centroConfig };
  try {
    config = await (await fetch(`${API}/api/config`)).json();
  } catch (_) { /* centro por defecto */ }
  centroConfig = config.centro || centroConfig;

  const fuenteGrafo = String(config.fuente_grafo || '').toLowerCase();
  const esAcapulco = fuenteGrafo.includes('acapulco');
  const ciudad = esAcapulco ? 'Acapulco' : 'Puebla';
  $('ubicacion-nombre').textContent = ciudad;
  $('ubicacion-region').textContent = esAcapulco ? 'Gro, MX' : 'Pue, MX';

  mapa = L.map('mapa', {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
  }).setView([centroConfig.lat, centroConfig.lon], 15);

  // La retícula táctica siempre va de fondo: cubre las zonas sin teselas al
  // alejar el zoom y sirve de respaldo si no hay mapa descargado.
  new FondoTactico({
    tileSize: 256, minZoom: 0, maxZoom: 22, attribution: 'Fondo táctico local',
  }).addTo(mapa);

  if (config.tiles_url) {
    const nativoMin = config.tiles_min_zoom || null;
    const nativoMax = config.tiles_max_zoom || null;
    const opciones = {
      minZoom: 0,
      maxZoom: 19,
      minNativeZoom: nativoMin || undefined,
      maxNativeZoom: nativoMax || undefined,
      attribution: config.tiles_atribucion || '',
    };
    if (Array.isArray(config.tiles_bounds) && config.tiles_bounds.length === 4) {
      const [sur, oeste, norte, este] = config.tiles_bounds;
      opciones.bounds = L.latLngBounds([sur, oeste], [norte, este]);
    }
    const capaTeselas = L.tileLayer(config.tiles_url, opciones).addTo(mapa);
    // El filtro oscuro se aplica sólo a las teselas reales, no a la retícula
    // táctica de respaldo (que ya está pensada en tonos oscuros).
    if (config.tiles_oscuras !== false) {
      const cont = capaTeselas.getContainer();
      if (cont) cont.classList.add('teselas-oscuras');
    }
    if (config.tiles_local) {
      $('chip-fondo').innerHTML = `<span class="led ok"></span> ${ciudad} · teselas offline`;
      $('txt-fondo').textContent = 'teselas OpenStreetMap offline';
    } else {
      $('chip-fondo').innerHTML = '<span class="led ok"></span> OSM en línea';
      $('txt-fondo').textContent = 'OpenStreetMap en línea';
    }
    // Si el nodo se queda sin internet, la retícula táctica (capa de fondo)
    // sigue visible; avisamos en el chip tras varios errores de tesela.
    let erroresTeselas = 0;
    capaTeselas.on('tileerror', () => {
      erroresTeselas += 1;
      if (erroresTeselas === 3) {
        $('chip-fondo').innerHTML = '<span class="led warn"></span> Sin conexión · fondo táctico';
        $('txt-fondo').textContent = 'sin conexión · fondo local';
      }
    });
  } else {
    $('chip-fondo').innerHTML = '<span class="led ok"></span> Fondo local offline';
    $('txt-fondo').textContent = 'fondo local offline';
  }

  L.control.scale({ position: 'bottomright', imperial: false }).addTo(mapa);

  L.marker([centroConfig.lat, centroConfig.lon], {
    interactive: false,
    icon: L.divIcon({ className: '', html: '<div class="marcador-centro"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
  }).addTo(mapa);
  const fuente = (config.fuente_grafo || '').includes('grafo.graphml')
    ? 'grafo OSM'
    : (config.fuente_grafo || '—');
  $('chip-centro').textContent =
    `Centro ${centroConfig.lat.toFixed(4)}, ${centroConfig.lon.toFixed(4)} · ${fuente}`;

  CAPAS.zonas = L.layerGroup().addTo(mapa);
  CAPAS.riesgos = L.layerGroup().addTo(mapa);
  CAPAS.bloqueos = L.layerGroup().addTo(mapa);
  CAPAS.posiciones = L.layerGroup().addTo(mapa);

  mapa.on('mousemove', (ev) => {
    $('chip-coords').textContent = `${ev.latlng.lat.toFixed(5)}, ${ev.latlng.lng.toFixed(5)}`;
  });
  mapa.on('mouseout', () => { $('chip-coords').textContent = '—'; });

  mapa.on('click', (ev) => {
    if (!modoPunto) return;
    const { lat, lng } = ev.latlng;
    const tipo = modoPunto;
    if (tipo === 'origen') {
      origen = [lat, lng];
      $('in-o-lat').value = lat.toFixed(6);
      $('in-o-lon').value = lng.toFixed(6);
    } else {
      destino = [lat, lng];
      $('in-d-lat').value = lat.toFixed(6);
      $('in-d-lon').value = lng.toFixed(6);
    }
    actualizarMarcadorPunto(tipo, [lat, lng]);
    modoPunto = null;
    $('btn-modo-origen').classList.remove('activo');
    $('btn-modo-destino').classList.remove('activo');
    $('chip-aviso').textContent = 'Punto fijado · ajusta o calcula la ruta';
    if (origen && destino && $('chk-autorruta').checked) calcularRuta();
  });

  // El contenedor cambia de tamaño al cargar fuentes/layout: recalcula.
  requestAnimationFrame(() => mapa.invalidateSize());
  setTimeout(() => mapa && mapa.invalidateSize(), 250);
  window.addEventListener('resize', () => mapa && mapa.invalidateSize());
}

// --------------------------------------------------------------------------
// Capas
// --------------------------------------------------------------------------
function actualizarRescatista(feature) {
  const props = feature.properties || {};
  const coord = feature.geometry ? feature.geometry.coordinates : null;
  if (!coord) return;
  const id = props.rescatista_id || 'desconocido';
  const latlng = [coord[1], coord[0]];
  const num = String(props.cuadrilla || '').match(/(\d+)/);
  const inicial = num ? num[1] : (id.replace(/[^0-9A-Za-z]/g, '').slice(-2) || 'R').toUpperCase();

  const prev = marcadoresRescate.get(id);
  if (prev) {
    prev.setLatLng(latlng);
    prev.setPopupContent(contenidoRescate(id, feature));
  } else {
    const m = L.marker(latlng, {
      icon: L.divIcon({ className: '', html: `<div class="marcador-rescate">${inicial}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
    }).addTo(CAPAS.posiciones);
    m.bindPopup(contenidoRescate(id, feature));
    marcadoresRescate.set(id, m);
  }
}

function contenidoRescate(id, feature) {
  const p = feature.properties || {};
  const [lon, lat] = feature.geometry.coordinates;
  return (
    popup(`Rescatista ${id}`, [
      ['Cuadrilla', p.cuadrilla],
      ['Precisión', p.precision_m != null ? p.precision_m.toFixed(1) + ' m' : null],
      ['Altitud', p.altitud != null ? p.altitud.toFixed(1) + ' m' : null],
      ['Hora', p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : null],
    ]) +
    `<div style="margin-top:9px;display:flex;gap:6px">
       <button class="btn" style="padding:5px 8px;font-size:11.5px" onclick="MeshResQ.usarComo('origen',${lat},${lon})">Origen</button>
       <button class="btn" style="padding:5px 8px;font-size:11.5px" onclick="MeshResQ.usarComo('destino',${lat},${lon})">Destino</button>
     </div>`
  );
}

function dibujarZona(feature) {
  const id = feature.properties.id;
  if (zonasDibujadas.has(id)) return;
  zonasDibujadas.add(id);
  L.geoJSON(feature, {
    style: { color: '#8fe3a8', weight: 1.6, fillColor: '#8fe3a8', fillOpacity: 0.12 },
    onEachFeature: (_f, capa) =>
      capa.bindPopup(popup('Zona peinada', [
        ['Cuadrilla', feature.properties.cuadrilla_id],
        ['Observaciones', feature.properties.observaciones],
      ])),
  }).addTo(CAPAS.zonas);
}

function dibujarRiesgo(feature) {
  const id = feature.properties.id;
  const [lon, lat] = feature.geometry.coordinates;
  const radio = feature.properties.radio_afectacion_m || 10;
  marcadoresRiesgo.get(id)?.remove();
  const grupo = L.layerGroup();
  L.circle([lat, lon], { radius: radio, color: '#ffb84d', weight: 1.2, fillColor: '#ffb84d', fillOpacity: 0.14 }).addTo(grupo);
  L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html: '<div class="marcador-riesgo">!</div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
  }).addTo(grupo).bindPopup(
    popup(`Riesgo ${feature.properties.tipo_riesgo}`, [
      ['Gravedad', feature.properties.nivel_gravedad + '/5'],
      ['Radio', radio + ' m'],
      ['Descripción', feature.properties.descripcion],
    ])
  );
  grupo.addTo(CAPAS.riesgos);
  marcadoresRiesgo.set(id, grupo);
}

function dibujarBloqueo(feature) {
  const id = feature.properties.id;
  const [lon, lat] = feature.geometry.coordinates;
  const radio = feature.properties.radio_bloqueo_m || 15;
  marcadoresBloqueo.get(id)?.grupo.remove();
  const grupo = L.layerGroup();
  L.circle([lat, lon], { radius: radio, color: '#ff6b6b', weight: 1.6, fillColor: '#ff6b6b', fillOpacity: 0.18 }).addTo(grupo);
  L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html: '<div class="marcador-bloqueo"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
  }).addTo(grupo).bindPopup(
    popup(`Bloqueo ${feature.properties.tipo_obstaculo}`, [
      ['Radio', radio + ' m'],
      ['Descripción', feature.properties.descripcion],
      ['Hora', feature.properties.timestamp ? new Date(feature.properties.timestamp).toLocaleTimeString() : null],
    ]) + `<button class="btn" style="margin-top:9px;padding:6px 10px;font-size:11.5px;width:100%" onclick="MeshResQ.liberarBloqueo(${id})">Marcar como liberado</button>`
  );
  grupo.addTo(CAPAS.bloqueos);
  marcadoresBloqueo.set(id, { grupo, feature });
}

function actualizarMetricas() {
  const bloqueos = marcadoresBloqueo.size;
  const riesgos = marcadoresRiesgo.size;
  const zonas = zonasDibujadas.size;
  const unidades = marcadoresRescate.size;

  $('n-bloqueos').textContent = bloqueos;
  $('n-riesgos').textContent = riesgos;
  $('n-zonas').textContent = zonas;
  $('n-posiciones').textContent = unidades;
  $('m-rescatistas').textContent = unidades;

  const alertas = bloqueos + riesgos;
  $('hero-alertas').textContent = alertas;
  const pill = $('hero-pill');
  pill.className = 'status-pill ' + (alertas === 0 ? 'ok' : alertas >= 3 ? 'bad' : 'warn');
  $('hero-pill-txt').textContent = alertas === 0 ? 'Sin alertas' : `${alertas} en atención`;
  $('hero-hora').textContent = new Date().toLocaleTimeString();
}

function renderEstadoGlobal(fc) {
  if (!fc || !fc.features) return;
  const activos = new Set();
  for (const feature of fc.features) {
    switch (feature.properties?.capa) {
      case 'posiciones': actualizarRescatista(feature); break;
      case 'zonas_peinadas': dibujarZona(feature); break;
      case 'riesgos': dibujarRiesgo(feature); break;
      case 'bloqueos': dibujarBloqueo(feature); activos.add(feature.properties.id); break;
    }
  }
  for (const [id, item] of marcadoresBloqueo) {
    if (!activos.has(id)) { item.grupo.remove(); marcadoresBloqueo.delete(id); }
  }

  const motor = fc.metadata?.motor_ruteo;
  if (motor) {
    $('txt-grafo').textContent = `${motor.nodos} nodos`;
    led('led-grafo', 'ok');
  }
  led('led-api', 'ok');
  $('txt-api').textContent = 'ok';
  marcarNodo('ok', 'en línea');
  actualizarMetricas();

  if (primeraCarga) { primeraCarga = false; encuadrarDatos(); }
}

async function cargarEstadoGlobal() {
  const ventana = Number($('sel-ventana').value) || 0;
  try {
    const fc = await (await fetch(`${API}/api/control/estado-global?segundos_posiciones=${ventana}`)).json();
    renderEstadoGlobal(fc);
    if (!ws || ws.readyState !== WebSocket.OPEN) marcarBanner('warn');
  } catch (err) {
    led('led-api', 'bad');
    $('txt-api').textContent = 'error';
    marcarNodo('bad', 'sin enlace');
    marcarBanner('bad');
  }
}

function encuadrarDatos() {
  const puntos = [];
  for (const m of marcadoresRescate.values()) puntos.push(m.getLatLng());
  for (const { grupo } of marcadoresBloqueo.values()) {
    grupo.eachLayer((l) => l.getLatLng && puntos.push(l.getLatLng()));
  }
  if (puntos.length >= 2) mapa.fitBounds(L.latLngBounds(puntos).pad(0.35), { maxZoom: 17, animate: false });
}

// --------------------------------------------------------------------------
// Ruteo
// --------------------------------------------------------------------------
function leerPunto(a, b) {
  const lat = parseFloat($(a).value), lon = parseFloat($(b).value);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

function iconoPunto(destino = false) {
  return L.divIcon({
    className: '',
    html: `<div class="marcador-punto${destino ? ' destino' : ''}"></div>`,
    iconSize: [17, 17],
    iconAnchor: [8.5, 8.5],
  });
}

function actualizarMarcadorPunto(tipo, coords) {
  if (!mapa || !coords) return;
  const [lat, lon] = coords;
  if (tipo === 'origen') {
    if (marcadorOrigen) marcadorOrigen.setLatLng([lat, lon]);
    else {
      marcadorOrigen = L.marker([lat, lon], {
        icon: iconoPunto(false), zIndexOffset: 700,
      }).addTo(mapa);
    }
  } else {
    if (marcadorDestino) marcadorDestino.setLatLng([lat, lon]);
    else {
      marcadorDestino = L.marker([lat, lon], {
        icon: iconoPunto(true), zIndexOffset: 700,
      }).addTo(mapa);
    }
  }
}

function limpiarMarcadoresPunto() {
  if (marcadorOrigen) { marcadorOrigen.remove(); marcadorOrigen = null; }
  if (marcadorDestino) { marcadorDestino.remove(); marcadorDestino = null; }
}

async function calcularRuta() {
  origen = leerPunto('in-o-lat', 'in-o-lon');
  destino = leerPunto('in-d-lat', 'in-d-lon');
  const panel = $('resultado-ruta');
  if (!origen || !destino) {
    panel.innerHTML = '<span class="err">Define origen y destino.</span>';
    return;
  }
  actualizarMarcadorPunto('origen', origen);
  actualizarMarcadorPunto('destino', destino);
  const velKmh = Number($('in-velocidad').value) || 30;
  try {
    const params = new URLSearchParams({
      origen_lat: origen[0], origen_lon: origen[1],
      destino_lat: destino[0], destino_lon: destino[1],
      velocidad_m_s: (velKmh / 3.6).toFixed(3),
    });
    const resp = await fetch(`${API}/api/ruteo/optimo?${params}`);
    const datos = await resp.json();
    if (!resp.ok) {
      panel.innerHTML = `<span class="err">${datos.detail || 'Sin ruta disponible'}</span>`;
      if (rutaLinea) { rutaLinea.remove(); rutaLinea = null; }
      return;
    }
    if (rutaLinea) rutaLinea.remove();
    rutaLinea = L.geoJSON(datos.geojson, { style: { color: '#d6f24a', weight: 5, opacity: 0.95, lineJoin: 'round' } }).addTo(mapa);
    rutaLinea.bindPopup(popup('Ruta óptima', [
      ['Distancia', (datos.distancia_m / 1000).toFixed(2) + ' km'],
      ['Duración est.', Math.round(datos.duracion_s / 60) + ' min'],
      ['Bloqueos esquivados', datos.bloqueos_esquivados],
    ]));
    mapa.fitBounds(rutaLinea.getBounds(), { padding: [50, 50], maxZoom: 17, animate: false });
    panel.innerHTML =
      `Distancia <b>${(datos.distancia_m / 1000).toFixed(2)} km</b> · ` +
      `tiempo <b>${Math.round(datos.duracion_s / 60)} min</b> · ` +
      `esquiva <b>${datos.bloqueos_esquivados}</b> bloqueo(s)`;
    log(`Ruta calculada: ${(datos.distancia_m / 1000).toFixed(2)} km`);
  } catch (err) {
    panel.innerHTML = '<span class="err">Error de conexión con el motor de ruteo.</span>';
  }
}

function limpiarRuta() {
  if (rutaLinea) { rutaLinea.remove(); rutaLinea = null; }
  $('resultado-ruta').textContent = 'Define origen y destino, o usa un rescatista del mapa.';
}

function reiniciarVista() {
  limpiarRuta();
  limpiarMarcadoresPunto();
  for (const id of ['in-o-lat', 'in-o-lon', 'in-d-lat', 'in-d-lon']) $(id).value = '';
  origen = null; destino = null; modoPunto = null;
  $('btn-modo-origen').classList.remove('activo');
  $('btn-modo-destino').classList.remove('activo');
  $('chip-aviso').textContent = 'Selecciona ◎ Origen o ⚑ Destino y clic en el mapa';
  if (mapa) mapa.setView([centroConfig.lat, centroConfig.lon], 15);
  cargarEstadoGlobal();
  log('Vista reiniciada');
}

// --------------------------------------------------------------------------
// API de popups
// --------------------------------------------------------------------------
window.MeshResQ = {
  usarComo(tipo, lat, lon) {
    if (tipo === 'origen') {
      origen = [lat, lon]; $('in-o-lat').value = lat.toFixed(6); $('in-o-lon').value = lon.toFixed(6);
    } else {
      destino = [lat, lon]; $('in-d-lat').value = lat.toFixed(6); $('in-d-lon').value = lon.toFixed(6);
    }
    actualizarMarcadorPunto(tipo, [lat, lon]);
    mapa.closePopup();
    log(`Punto de ${tipo} fijado (${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)})`);
    if ($('chk-autorruta').checked && origen && destino) calcularRuta();
  },
  async liberarBloqueo(id) {
    try {
      await fetch(`${API}/api/bloqueos/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activo: false }),
      });
      log(`Bloqueo #${id} liberado`, 'bloqueo');
    } catch (err) { console.warn(err); }
  },
};

// --------------------------------------------------------------------------
// WebSocket en vivo
// --------------------------------------------------------------------------
let ws = null, reintento = null;

function conectarWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/control`);
  ws.onopen = () => {
    led('led-ws', 'ok');
    $('txt-ws').textContent = 'ok';
    marcarBanner('ok');
    marcarNodo('ok', 'en vivo');
    log('Enlace en vivo establecido');
  };
  ws.onmessage = (e) => { try { manejarMensaje(JSON.parse(e.data)); } catch { /* ignora */ } };
  ws.onclose = () => {
    led('led-ws', 'bad');
    $('txt-ws').textContent = 'reconectando';
    marcarBanner('warn');
    marcarNodo('warn', 'reconectando');
    clearTimeout(reintento);
    reintento = setTimeout(conectarWS, 3000);
  };
  ws.onerror = () => ws.close();
}

function manejarMensaje(msg) {
  const { tipo, data } = msg;
  switch (tipo) {
    case 'snapshot':
      renderEstadoGlobal(data);
      break;
    case 'telemetria_batch':
      actualizarRescatista(data);
      actualizarMetricas();
      break;
    case 'zona_peinada':
      dibujarZona(data); actualizarMetricas();
      log(`Zona peinada de ${data.properties.cuadrilla_id}`, 'zona');
      break;
    case 'riesgo':
      dibujarRiesgo(data); actualizarMetricas();
      log(`Riesgo ${data.properties.tipo_riesgo} · gravedad ${data.properties.nivel_gravedad}`, 'riesgo');
      break;
    case 'bloqueo':
      dibujarBloqueo(data); actualizarMetricas();
      log(`Bloqueo ${data.properties.tipo_obstaculo} reportado`, 'bloqueo');
      if ($('chk-autorruta').checked && origen && destino) calcularRuta();
      break;
    case 'bloqueo_actualizado':
      if (!data.properties.activo) {
        marcadoresBloqueo.get(data.properties.id)?.grupo.remove();
        marcadoresBloqueo.delete(data.properties.id);
        actualizarMetricas();
        log(`Bloqueo #${data.properties.id} liberado`, 'bloqueo');
        if ($('chk-autorruta').checked && origen && destino) calcularRuta();
      }
      break;
  }
}

// --------------------------------------------------------------------------
// Controles
// --------------------------------------------------------------------------
function aplicarPreset(nombre) {
  const activas = new Set(PRESETS[nombre] || PRESETS.tactico);
  for (const [id, capa] of CAPAS_UI) {
    const activa = activas.has(capa);
    $(id).checked = activa;
    if (activa) CAPAS[capa].addTo(mapa);
    else mapa.removeLayer(CAPAS[capa]);
  }
  document.querySelectorAll('#presets .opt').forEach((btn) => {
    btn.classList.toggle('activo', btn.dataset.preset === nombre);
  });
}

function enlazarControles() {
  const modo = (cual) => {
    modoPunto = modoPunto === cual ? null : cual;
    $('btn-modo-origen').classList.toggle('activo', modoPunto === 'origen');
    $('btn-modo-destino').classList.toggle('activo', modoPunto === 'destino');
    $('chip-aviso').textContent = modoPunto
      ? `Haz clic en el mapa para fijar ${modoPunto === 'origen' ? 'el ORIGEN' : 'el DESTINO'}`
      : 'Selecciona ◎ Origen o ⚑ Destino y clic en el mapa';
  };
  $('btn-modo-origen').addEventListener('click', () => modo('origen'));
  $('btn-modo-destino').addEventListener('click', () => modo('destino'));
  $('btn-ruta').addEventListener('click', calcularRuta);
  $('btn-limpiar-ruta').addEventListener('click', limpiarRuta);
  $('btn-reset').addEventListener('click', reiniciarVista);

  $('sel-ventana').addEventListener('change', cargarEstadoGlobal);

  $('in-velocidad').addEventListener('input', (ev) => {
    $('txt-velocidad').textContent = ev.target.value;
  });

  for (const [id, capa] of CAPAS_UI) {
    $(id).addEventListener('change', (ev) => {
      if (ev.target.checked) CAPAS[capa].addTo(mapa);
      else mapa.removeLayer(CAPAS[capa]);
      document.querySelectorAll('#presets .opt').forEach((btn) => btn.classList.remove('activo'));
    });
  }

  document.querySelectorAll('#presets .opt').forEach((btn) => {
    btn.addEventListener('click', () => aplicarPreset(btn.dataset.preset));
  });

  const botonesZoom = [...document.querySelectorAll('#zoom-rail button')];
  const marcarZoom = () => {
    const z = mapa.getZoom();
    botonesZoom.forEach((btn) => {
      btn.classList.toggle('activo', Number(btn.dataset.zoom) === z);
    });
  };
  botonesZoom.forEach((btn) => {
    btn.addEventListener('click', () => mapa.setZoom(Number(btn.dataset.zoom)));
  });
  mapa.on('zoomend', marcarZoom);
  marcarZoom();

  const bitacora = $('bitacora');
  const alternarBitacora = () => {
    const oculta = bitacora.classList.toggle('oculto');
    $('btn-log').classList.toggle('activo', !oculta);
    $('btn-log').setAttribute('aria-expanded', String(!oculta));
  };
  $('btn-log').addEventListener('click', alternarBitacora);
  $('btn-cerrar-log').addEventListener('click', alternarBitacora);
}

function enlazarScrollHint() {
  const sidebar = document.querySelector('.sidebar');
  const hint = $('scroll-hint');
  if (!sidebar || !hint) return;

  const actualizar = () => {
    const desborda = sidebar.scrollHeight > sidebar.clientHeight + 8;
    const alFinal = sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 12;
    hint.classList.toggle('hint-off', !desborda || alFinal);
  };

  hint.addEventListener('click', () => {
    $('seccion-ruteo').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  hint.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      hint.click();
    }
  });
  sidebar.addEventListener('scroll', actualizar, { passive: true });
  window.addEventListener('resize', actualizar);
  actualizar();
  setTimeout(actualizar, 300);
}

function iniciarReloj() {
  const tic = () => { $('txt-reloj').textContent = new Date().toLocaleTimeString(); };
  tic();
  setInterval(tic, 1000);
}

// --------------------------------------------------------------------------
// Arranque
// --------------------------------------------------------------------------
async function iniciar() {
  iniciarReloj();
  marcarBanner('warn');
  await iniciarMapa();
  enlazarControles();
  enlazarScrollHint();
  await cargarEstadoGlobal();
  conectarWS();
  setInterval(() => { if (!ws || ws.readyState !== WebSocket.OPEN) cargarEstadoGlobal(); }, 6000);
}

document.addEventListener('DOMContentLoaded', iniciar);
