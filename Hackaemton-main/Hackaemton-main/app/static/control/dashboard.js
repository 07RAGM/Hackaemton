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
const COLOR_ACENTO = '#d6f24a';
const COLOR_ROJO = '#ff6b6b';
const COLOR_AMBAR = '#ffb84d';
const COLOR_VERDE = '#8fe3a8';
const CAPAS = {};
const marcadoresRescate = new Map();
const marcadoresBloqueo = new Map();
const marcadoresRiesgo = new Map();
const zonasDibujadas = new Set();

let mapa = null;
let rutaLinea = null;
let origen = null;
let destino = null;
let modoPunto = null;
let primeraCarga = true;
let centroConfig = { lat: 19.0433, lon: -98.1987 };
let marcadorOrigen = null;
let marcadorDestino = null;

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------
// Utilidades
// --------------------------------------------------------------------------
function log(texto, clase = '') {
  const caja = $('log');
  if (!caja) return;
  const ev = document.createElement('div');
  ev.className = 'ev ' + clase;
  ev.innerHTML = `<b>${texto}</b><time>${new Date().toLocaleTimeString()}</time>`;
  caja.prepend(ev);
  while (caja.children.length > 40) caja.removeChild(caja.lastChild);
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

    const paso = 20;
    for (let x = paso / 2; x < size.x; x += paso) {
      for (let y = paso / 2; y < size.y; y += paso) {
        const mayor = (x - paso / 2) % (paso * 4) === 0 && (y - paso / 2) % (paso * 4) === 0;
        ctx.fillStyle = mayor ? 'rgba(214,242,74,0.28)' : 'rgba(168,168,168,0.15)';
        ctx.beginPath();
        ctx.arc(x, y, mayor ? 1.35 : 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.028)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const p = Math.round((i * size.x) / 4) + 0.5;
      ctx.moveTo(p, 0); ctx.lineTo(p, size.y);
      ctx.moveTo(0, p); ctx.lineTo(size.x, p);
    }
    ctx.stroke();

    const nw = this._tileCoordsToBounds(coords).getNorthWest();
    ctx.fillStyle = 'rgba(150,150,150,0.42)';
    ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(`${nw.lat.toFixed(4)}  ${nw.lng.toFixed(4)}`, 9, 16);

    return tile;
  },
});

const ReticulaOverlay = L.GridLayer.extend({
  createTile(coords) {
    const size = this.getTileSize();
    const tile = L.DomUtil.create('canvas', 'leaflet-tile');
    tile.width = size.x;
    tile.height = size.y;
    const ctx = tile.getContext('2d');

    const paso = 32;
    for (let x = paso / 2; x < size.x; x += paso) {
      for (let y = paso / 2; y < size.y; y += paso) {
        const mayor = (x - paso / 2) % (paso * 4) === 0 && (y - paso / 2) % (paso * 4) === 0;
        ctx.fillStyle = mayor ? 'rgba(214,242,74,0.22)' : 'rgba(255,255,255,0.13)';
        ctx.beginPath();
        ctx.arc(x, y, mayor ? 1.1 : 0.75, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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

  const paneReticula = mapa.createPane('reticula');
  paneReticula.style.zIndex = 350;
  paneReticula.style.pointerEvents = 'none';
  new ReticulaOverlay({
    pane: 'reticula', interactive: false, tileSize: 256, minZoom: 0, maxZoom: 22,
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
      $('chip-fondo').innerHTML = '<span class="led ok"></span> Acapulco · teselas offline';
    } else {
      $('chip-fondo').innerHTML = '<span class="led ok"></span> OSM en línea';
    }
    // Si el nodo se queda sin internet, la retícula táctica (capa de fondo)
    // sigue visible; avisamos en el chip tras varios errores de tesela.
    let erroresTeselas = 0;
    capaTeselas.on('tileerror', () => {
      erroresTeselas += 1;
      if (erroresTeselas === 3) {
        $('chip-fondo').innerHTML = '<span class="led warn"></span> Sin conexión · fondo táctico';
      }
    });
  } else {
    $('chip-fondo').innerHTML = '<span class="led warn"></span> Fondo táctico local';
  }

  L.control.scale({ position: 'bottomright', imperial: false }).addTo(mapa);
  mapa.on('zoomend', actualizarZoomRail);
  document.querySelectorAll('#zoom-rail button').forEach((btn) => {
    btn.addEventListener('click', () => mapa.setZoom(Number(btn.dataset.zoom)));
  });

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
  mapa.on('mouseout', () => { $('chip-coords').textContent = 'Coordenadas —'; });

  mapa.on('click', (ev) => {
    if (!modoPunto) return;
    const { lat, lng } = ev.latlng;
    if (modoPunto === 'origen') {
      origen = [lat, lng];
      $('in-o-lat').value = lat.toFixed(6);
      $('in-o-lon').value = lng.toFixed(6);
      marcarPunto('origen', lat, lng);
    } else {
      destino = [lat, lng];
      $('in-d-lat').value = lat.toFixed(6);
      $('in-d-lon').value = lng.toFixed(6);
      marcarPunto('destino', lat, lng);
    }
    modoPunto = null;
    $('btn-modo-origen').classList.remove('activo');
    $('btn-modo-destino').classList.remove('activo');
    $('chip-aviso').textContent = 'Punto fijado · ajusta o calcula la ruta';
    if (origen && destino && $('chk-autorruta').checked) calcularRuta();
  });

  actualizarZoomRail();
  requestAnimationFrame(() => mapa.invalidateSize());
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
    style: { color: COLOR_VERDE, weight: 1.2, fillColor: COLOR_VERDE, fillOpacity: 0.10 },
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
  L.circle([lat, lon], { radius: radio, color: COLOR_AMBAR, weight: 1.1, fillColor: COLOR_AMBAR, fillOpacity: 0.12 }).addTo(grupo);
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
  L.circle([lat, lon], { radius: radio, color: COLOR_ROJO, weight: 1.3, fillColor: COLOR_ROJO, fillOpacity: 0.16 }).addTo(grupo);
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
  const rescatistas = marcadoresRescate.size;
  const alertas = bloqueos + riesgos;

  $('m-rescatistas').textContent = rescatistas;
  $('n-bloqueos').textContent = bloqueos;
  $('n-riesgos').textContent = riesgos;
  $('n-zonas').textContent = zonas;
  $('n-posiciones').textContent = rescatistas;

  $('hero-alertas').textContent = alertas;
  const pill = $('hero-pill');
  let nivel = 'ok';
  let texto = 'Sin alertas';
  if (alertas > 0) {
    texto = alertas < 3 ? 'Bajo' : alertas < 6 ? 'Moderado' : 'Crítico';
    nivel = alertas < 3 ? 'ok' : alertas < 6 ? 'warn' : 'bad';
  }
  pill.className = 'status-pill ' + nivel;
  $('hero-pill-txt').textContent = texto;
  $('hero-hora').textContent = new Date().toLocaleTimeString('es-MX', {
    hour: '2-digit', minute: '2-digit',
  });
}

function marcarPunto(tipo, lat, lon) {
  if (!mapa) return;
  const icono = L.divIcon({
    className: '',
    html: `<div class="marcador-punto${tipo === 'destino' ? ' destino' : ''}"></div>`,
    iconSize: [17, 17],
    iconAnchor: [8.5, 8.5],
  });
  const actual = tipo === 'origen' ? marcadorOrigen : marcadorDestino;
  if (actual) {
    actual.setLatLng([lat, lon]);
  } else if (tipo === 'origen') {
    marcadorOrigen = L.marker([lat, lon], { icon: icono, zIndexOffset: 600 }).addTo(mapa);
  } else {
    marcadorDestino = L.marker([lat, lon], { icon: icono, zIndexOffset: 600 }).addTo(mapa);
  }
}

function actualizarZoomRail() {
  if (!mapa) return;
  const zoom = Math.round(mapa.getZoom());
  document.querySelectorAll('#zoom-rail button').forEach((btn) => {
    btn.classList.toggle('activo', Number(btn.dataset.zoom) === zoom);
  });
}

function actualizarScrollHint() {
  const barra = document.querySelector('.sidebar');
  const hint = $('scroll-hint');
  if (!barra || !hint) return;
  const desborda = barra.scrollHeight > barra.clientHeight + 4;
  const alFinal = barra.scrollTop + barra.clientHeight >= barra.scrollHeight - 10;
  hint.classList.toggle('hint-off', !desborda || alFinal);
}

function irARuteo() {
  const destino = $('seccion-ruteo');
  if (destino) destino.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  actualizarMetricas();

  if (primeraCarga) { primeraCarga = false; encuadrarDatos(); }
}

async function cargarEstadoGlobal() {
  try {
    const fc = await (await fetch(`${API}/api/control/estado-global?segundos_posiciones=300`)).json();
    renderEstadoGlobal(fc);
  } catch (err) {
    console.warn(err);
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

async function calcularRuta() {
  origen = leerPunto('in-o-lat', 'in-o-lon');
  destino = leerPunto('in-d-lat', 'in-d-lon');
  const panel = $('resultado-ruta');
  if (!origen || !destino) {
    panel.innerHTML = '<span class="err">Define origen y destino.</span>';
    return;
  }
  marcarPunto('origen', origen[0], origen[1]);
  marcarPunto('destino', destino[0], destino[1]);
  try {
    const params = new URLSearchParams({
      origen_lat: origen[0], origen_lon: origen[1],
      destino_lat: destino[0], destino_lon: destino[1],
    });
    const resp = await fetch(`${API}/api/ruteo/optimo?${params}`);
    const datos = await resp.json();
    if (!resp.ok) {
      panel.innerHTML = `<span class="err">${datos.detail || 'Sin ruta disponible'}</span>`;
      if (rutaLinea) { rutaLinea.remove(); rutaLinea = null; }
      return;
    }
    if (rutaLinea) rutaLinea.remove();
    rutaLinea = L.geoJSON(datos.geojson, { style: { color: COLOR_ACENTO, weight: 3.5, opacity: 0.98, lineJoin: 'round' } }).addTo(mapa);
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
  for (const id of ['in-o-lat', 'in-o-lon', 'in-d-lat', 'in-d-lon']) $(id).value = '';
  origen = null; destino = null; modoPunto = null;
  if (marcadorOrigen) { marcadorOrigen.remove(); marcadorOrigen = null; }
  if (marcadorDestino) { marcadorDestino.remove(); marcadorDestino = null; }
  $('btn-modo-origen').classList.remove('activo');
  $('btn-modo-destino').classList.remove('activo');
  $('chip-aviso').textContent = 'Selecciona Origen o Destino y haz clic en el mapa';
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
    marcarPunto(tipo, lat, lon);
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
    log('Enlace en vivo establecido');
  };
  ws.onmessage = (e) => { try { manejarMensaje(JSON.parse(e.data)); } catch { /* ignora */ } };
  ws.onclose = () => {
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
  const presets = {
    tactico: { bloqueos: true, riesgos: true, zonas: true, posiciones: true },
    rescate: { bloqueos: false, riesgos: false, zonas: true, posiciones: true },
    ruta: { bloqueos: true, riesgos: false, zonas: false, posiciones: true },
  };
  const preset = presets[nombre];
  if (!preset) return;
  for (const [id, capa] of [['chk-bloqueos', 'bloqueos'], ['chk-riesgos', 'riesgos'], ['chk-zonas', 'zonas'], ['chk-posiciones', 'posiciones']]) {
    $(id).checked = preset[capa];
    if (preset[capa]) CAPAS[capa].addTo(mapa);
    else mapa.removeLayer(CAPAS[capa]);
  }
  document.querySelectorAll('#presets .opt').forEach((btn) => {
    btn.classList.toggle('activo', btn.dataset.preset === nombre);
  });
  log(`Modo de mapa: ${nombre}`);
}

function enlazarControles() {
  const modo = (cual) => {
    modoPunto = modoPunto === cual ? null : cual;
    $('btn-modo-origen').classList.toggle('activo', modoPunto === 'origen');
    $('btn-modo-destino').classList.toggle('activo', modoPunto === 'destino');
    $('chip-aviso').textContent = modoPunto
      ? `Haz clic en el mapa para fijar ${modoPunto === 'origen' ? 'el ORIGEN' : 'el DESTINO'}`
      : 'Selecciona Origen o Destino y haz clic en el mapa';
  };
  modoPunto = 'origen';
  $('chip-aviso').textContent = 'Haz clic en el mapa para fijar el ORIGEN';
  $('btn-modo-origen').addEventListener('click', () => modo('origen'));
  $('btn-modo-destino').addEventListener('click', () => modo('destino'));
  $('btn-ruta').addEventListener('click', calcularRuta);
  $('btn-limpiar-ruta').addEventListener('click', limpiarRuta);

  for (const [id, capa] of [['chk-bloqueos', 'bloqueos'], ['chk-riesgos', 'riesgos'], ['chk-zonas', 'zonas'], ['chk-posiciones', 'posiciones']]) {
    $(id).addEventListener('change', (ev) => {
      if (ev.target.checked) CAPAS[capa].addTo(mapa);
      else mapa.removeLayer(CAPAS[capa]);
      document.querySelectorAll('#presets .opt').forEach((btn) => btn.classList.remove('activo'));
    });
  }

  document.querySelectorAll('#presets .opt').forEach((btn) => {
    btn.addEventListener('click', () => aplicarPreset(btn.dataset.preset));
  });
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
  actualizarMetricas();
  await iniciarMapa();
  enlazarControles();
  await cargarEstadoGlobal();
  conectarWS();
  const barra = document.querySelector('.sidebar');
  const hint = $('scroll-hint');
  barra.addEventListener('scroll', actualizarScrollHint);
  window.addEventListener('resize', actualizarScrollHint);
  if (hint) {
    hint.addEventListener('click', irARuteo);
    hint.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); irARuteo(); }
    });
  }
  setTimeout(actualizarScrollHint, 80);
  setInterval(() => { if (!ws || ws.readyState !== WebSocket.OPEN) cargarEstadoGlobal(); }, 6000);
}

document.addEventListener('DOMContentLoaded', iniciar);
