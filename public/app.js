/* Apetitosos · lógica de la app (cliente). Antes vivía dentro de index.html (se separó para poder usar CSP). */
'use strict';
// La configuración real (clave del mapa, captcha, fecha del resumen) llega del servidor en /api/config al iniciar.
const CONFIG = {
  mapKey: '', turnstileSiteKey: '', plato: 'buñuelo', distanciaDuplicado: 60,
  limites: { latMin: 4.44, latMax: 4.84, lngMin: -74.23, lngMax: -73.98 },
  urlApp: location.origin + location.pathname,
  demoWrapped: new URLSearchParams(location.search).get('demo') === 'wrapped',
  // El resumen se abre desde este día (hora de Bogotá). Se puede cambiar con la variable RESUMEN_DESDE.
  resumenDesde: '2026-12-31',
  abrirResumen: new URLSearchParams(location.search).get('resumen') === '1'
};
const CON_SERVIDOR = /^https?:$/.test(location.protocol);
const $ = (id) => document.getElementById(id);

// ---------------- Estado ----------------
let mapa = null, mapaListo = false, mapaGrande = false;
let lugares = [], listas = [];
const marcadores = new Map();
let lugarAbierto = null;
let fantasma = null, puntoNuevo = null;
let ultimoToqueMarcador = 0;
let ultimaPosicion = null;
let vista = 'inicio';
let subInicio = 'top', subPerfil = 'diario', subActividad = 'amigos';
let listaAbierta = null;
let resaltado = null;
let modoDemo = false;

// Diario: lo que viene del servidor (con copia en el teléfono para abrir rápido)
let entradas = [];                     // [{ id, idLugar, fecha 'AAAA-MM-DD', cal, volveria, resena, creado, provocas }]
let porProbar = new Map();             // idLugar → fecha (ms)
let seguidas = new Set();              // ids de listas

// ---------------- Almacenamiento del navegador ----------------
const almacen = (function () {
  try { const k = '__prueba'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return localStorage; }
  catch { return null; }
})();
function leerLocal(clave, porDefecto) {
  try { const v = almacen && almacen.getItem(clave); return v ? JSON.parse(v) : porDefecto; } catch { return porDefecto; }
}
function guardarLocal(clave, valor) { try { if (almacen) almacen.setItem(clave, JSON.stringify(valor)); } catch {} }
function nuevoId() {
  if (window.crypto && crypto.randomUUID) return 'd-' + crypto.randomUUID();
  let s = 'd-'; for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16); return s;
}
const CLAVE_DISPOSITIVO = 'mejorbunuelo.dispositivo';
const CLAVE_VOTADOS = 'mejorbunuelo.votados.' + CONFIG.plato;
const CLAVE_DIARIO = 'buenamuela.diario';
const CLAVE_CUATRO = 'buenamuela.cuatro';
const CLAVE_BIENVENIDA = 'buenamuela.bienvenida';
const CLAVE_SEGUIDAS_VIEJA = 'mejorbunuelo.listasSeguidas';
const CLAVE_FILTRO = 'mejorbunuelo.filtroPrecio';
const CLAVE_ACTIVIDAD_VISTA = 'buenamuela.actividadVista';
let idDispositivo = leerLocal(CLAVE_DISPOSITIVO, null);
if (!idDispositivo) { idDispositivo = nuevoId(); guardarLocal(CLAVE_DISPOSITIVO, idDispositivo); }
const votados = new Set(leerLocal(CLAVE_VOTADOS, []));
function marcarVotado(id) { votados.add(id); guardarLocal(CLAVE_VOTADOS, Array.from(votados)); }
let cuatro = leerLocal(CLAVE_CUATRO, [null, null, null, null]);
if (!Array.isArray(cuatro) || cuatro.length !== 4) cuatro = [null, null, null, null];

(function leerDiarioGuardado() {
  const d = leerLocal('buenamuela.sesion', '') ? leerLocal(CLAVE_DIARIO, null) : null;
  if (!d) { seguidas = new Set(leerLocal(CLAVE_SEGUIDAS_VIEJA, [])); return; }
  entradas = Array.isArray(d.entradas) ? d.entradas : [];
  porProbar = new Map(Array.isArray(d.porProbar) ? d.porProbar.map((p) => [p.idLugar, p.fecha]) : []);
  seguidas = new Set(Array.isArray(d.seguidas) ? d.seguidas : []);
})();
function guardarDiario() {
  if (modoDemo) return;
  guardarLocal(CLAVE_DIARIO, {
    entradas, porProbar: Array.from(porProbar, ([idLugar, fecha]) => ({ idLugar, fecha })), seguidas: Array.from(seguidas)
  });
}

// Precios para "Cerca de ti"
const RANGOS_PRECIO = [
  { id: 'todos', etiqueta: 'Cualquiera', frase: '' },
  { id: 'hasta2000', etiqueta: 'Hasta $2.000', frase: 'de hasta $2.000', max: 2000 },
  { id: '2000a3000', etiqueta: '$2.000 a $3.000', frase: 'de más de $2.000 y hasta $3.000', min: 2000, minExclusivo: true, max: 3000 },
  { id: 'mas3000', etiqueta: 'Más de $3.000', frase: 'de más de $3.000', min: 3000, minExclusivo: true }
];
let filtroPrecio = leerLocal(CLAVE_FILTRO, 'todos');
if (!RANGOS_PRECIO.some((r) => r.id === filtroPrecio)) filtroPrecio = 'todos';
function rangoActual() { return RANGOS_PRECIO.find((r) => r.id === filtroPrecio) || RANGOS_PRECIO[0]; }
function tienePrecio(l) { return l.precio !== null && l.precio !== undefined && l.precio !== '' && !isNaN(l.precio); }
function enRango(l, r) {
  if (!r || r.id === 'todos') return true;
  if (!tienePrecio(l)) return false;
  const p = Number(l.precio);
  if (r.min !== undefined && (r.minExclusivo ? p <= r.min : p < r.min)) return false;
  if (r.max !== undefined && p > r.max) return false;
  return true;
}

// ---------------- Servidor ----------------
let tokenSesion = '';
async function pedir(ruta, cuerpo) {
  const cabeceras = tokenSesion ? { Authorization: 'Bearer ' + tokenSesion } : {};
  const r = await fetch(ruta, cuerpo === undefined ? { cache: 'no-store', headers: cabeceras } : {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, cabeceras), body: JSON.stringify(cuerpo)
  });
  const datos = await r.json().catch(() => null);
  if (!datos) throw new Error('Respuesta vacía del servidor (' + r.status + ')');
  if (!r.ok && datos.ok === false) return datos;
  if (!r.ok) throw new Error('Error ' + r.status);
  return datos;
}

// ---------------- Captcha (Cloudflare Turnstile) ----------------
let widgetCaptcha = null, captchaPendiente = null;
function cerrarCaptcha(error, token) {
  $('captcha-caja').hidden = true;
  const p = captchaPendiente; captchaPendiente = null;
  if (!p) return;
  clearTimeout(p.reloj);
  if (error) p.mal(error); else p.ok(token);
}
let scriptCaptcha = null;
function cargarTurnstile() {
  if (window.turnstile || scriptCaptcha) return;
  scriptCaptcha = document.createElement('script');
  scriptCaptcha.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  scriptCaptcha.async = true;
  document.head.appendChild(scriptCaptcha);
}
function tokenCaptcha() {
  if (!CONFIG.turnstileSiteKey) return Promise.resolve('');
  cargarTurnstile();
  return new Promise((ok, mal) => {
    if (captchaPendiente) cerrarCaptcha(new Error('reemplazado'));
    captchaPendiente = { ok, mal, reloj: setTimeout(() => cerrarCaptcha(new Error('El captcha tardó demasiado.')), 45000) };
    const arrancar = (intentos) => {
      if (!captchaPendiente) return;
      if (!window.turnstile) {
        if (intentos > 50) { cerrarCaptcha(new Error('No cargó el captcha.')); return; }
        setTimeout(() => arrancar(intentos + 1), 200); return;
      }
      if (widgetCaptcha === null) {
        widgetCaptcha = turnstile.render('#captcha', {
          sitekey: CONFIG.turnstileSiteKey, execution: 'execute', appearance: 'interaction-only', language: 'es',
          callback: (t) => cerrarCaptcha(null, t),
          'error-callback': () => { cerrarCaptcha(new Error('Falló el captcha.')); return true; },
          'expired-callback': () => {},
          'before-interactive-callback': () => { $('captcha-caja').hidden = false; },
          'after-interactive-callback': () => { $('captcha-caja').hidden = true; }
        });
      } else { turnstile.reset(widgetCaptcha); }
      turnstile.execute(widgetCaptcha);
    };
    arrancar(0);
  });
}

// ---------------- Ayudantes ----------------
function escapar(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function formatoPrecio(p) { return (p === null || p === undefined || isNaN(p)) ? 'Sin precio' : '$' + Number(p).toLocaleString('es-CO'); }
function formatoCal(c) { return String(c).replace('.', ','); }
function textoCal(c) {
  if (c <= 1) return 'Ni fu ni fa';
  if (c <= 2) return 'Normalito';
  if (c <= 3) return 'Bueno';
  if (c <= 4) return 'Muy bueno';
  if (c < 5) return 'Casi perfecto';
  return '¡De otro mundo!';
}
function distanciaMetros(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180, dLat = (c - a) * r, dLng = (d - b) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function dentroDeBogota(lat, lng) {
  const L = CONFIG.limites;
  return lat >= L.latMin && lat <= L.latMax && lng >= L.lngMin && lng <= L.lngMax;
}
function tamano(votos) { return Math.round(Math.min(70, 32 + Math.log2((votos || 0) + 1) * 7)); }
// Ranking. Cada calificación cuenta con su nota (la última de cada persona) y cada voto de "¡Este es el mejor!"
// cuenta como un 5. A todos los sitios se les suman CONFIANZA opiniones con la nota media de la ciudad: así un
// sitio con dos 5 no le gana a uno con muchas opiniones de 4,8 (promedio bayesiano, como Letterboxd o IMDb).
const CONFIANZA = 3;
function mediaCiudad() {
  let suma = 0, n = 0;
  lugares.forEach((l) => { suma += (l.nota || 0) * (l.opiniones || 0) + 5 * l.votos; n += (l.opiniones || 0) + l.votos; });
  return n ? suma / n : 3.5;
}
function puntaje(l, media) {
  const n = (l.opiniones || 0) + l.votos;
  return ((l.nota || 0) * (l.opiniones || 0) + 5 * l.votos + CONFIANZA * media) / (n + CONFIANZA);
}
function ordenados() {
  const media = mediaCiudad();
  return lugares.slice().sort((a, b) => (puntaje(b, media) - puntaje(a, media)) || (b.votos - a.votos) || (a.creado - b.creado));
}
/** Zona aproximada de Bogotá según las coordenadas, para darle color y sello a cada tarjeta. */
function zona(l) {
  if (l.lng < -74.105) return ['occidente', 'Occidente'];
  if (l.lat > 4.685) return ['norte', 'Norte'];
  if (l.lat < 4.6) return ['sur', 'Sur'];
  return ['centro', 'Centro'];
}
function lugarPorId(id) { return lugares.find((l) => l.id === id) || null; }
function bun(clase) { return '<svg class="bun ' + (clase || '') + '" viewBox="0 0 100 100" aria-hidden="true"><use href="#bunuelo"/></svg>'; }
function hoyBogota(menosDias) {
  return new Date(Date.now() - 5 * 3600000 - (menosDias || 0) * 86400000).toISOString().slice(0, 10);
}
const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function fechaCorta(f) { const [, m, d] = f.split('-').map(Number); return d + ' ' + MESES_LARGOS[m - 1].slice(0, 3) + '.'; }
function haceCuanto(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return 'hace ' + min + ' min';
  const h = Math.round(min / 60);
  if (h < 24) return 'hace ' + h + ' h';
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : 'hace ' + d + ' días';
}
function calHtml(c, t) {
  let h = '<span class="cal" role="img" aria-label="' + formatoCal(c) + ' de 5 buñuelos" style="--t:' + (t || 20) + 'px">';
  const icono = (cl) => '<svg class="' + cl + '" viewBox="0 0 100 100" aria-hidden="true"><use href="#bunuelo"/></svg>';
  for (let i = 1; i <= 5; i++) {
    if (c >= i) h += '<span>' + icono('') + '</span>';
    else if (c >= i - 0.5) h += '<span class="medio">' + icono('apagado') + icono('') + '</span>';
    else h += '<span>' + icono('apagado') + '</span>';
  }
  return h + '</span>';
}
function esMovil() { return window.innerWidth < 820; }

let temporizadorAviso = null;
function avisar(texto, tipo) {
  const el = $('aviso');
  el.textContent = texto;
  el.className = 'aviso visible' + (tipo === 'error' ? ' error' : '');
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { el.className = el.className.replace(' visible', ''); }, 3200);
}
function mostrarError(titulo, detalle) {
  $('carga').classList.remove('oculta');
  const svg = $('carga').querySelector('svg'); if (svg) svg.outerHTML = '<img src="/img/oso-triste.webp" alt="" style="width:150px;height:auto">';
  $('carga-texto').textContent = titulo;
  $('carga-detalle').textContent = detalle || '';
  $('carga-detalle').hidden = !detalle;
}

// ---------------- Diario: lo que se deriva ----------------
function entradasOrdenadas() {
  return entradas.slice().sort((a, b) => (b.fecha.localeCompare(a.fecha)) || (b.creado - a.creado));
}
/** Última anotación de cada sitio */
function ultimas() {
  const m = new Map();
  entradasOrdenadas().forEach((e) => { if (!m.has(e.idLugar)) m.set(e.idLugar, e); });
  return m;
}
function lunes(fecha) {
  const d = new Date(fecha + 'T12:00:00Z');
  const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia);
  return d.toISOString().slice(0, 10);
}
/** Semanas seguidas con al menos una anotación (cuenta si anotaste esta semana o la anterior). */
function racha(lista) {
  const semanas = new Set((lista || entradas).map((e) => lunes(e.fecha)));
  let s = lunes(hoyBogota());
  if (!semanas.has(s)) {
    const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 7); s = d.toISOString().slice(0, 10);
    if (!semanas.has(s)) return 0;
  }
  let n = 0;
  while (semanas.has(s)) {
    n++;
    const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 7); s = d.toISOString().slice(0, 10);
  }
  return n;
}

async function cargarDiario() {
  if (!CON_SERVIDOR || modoDemo || !tokenSesion) return;
  try {
    const r = await pedir('/api/diario');
    if (!r || !r.ok) return;
    entradas = r.entradas || [];
    porProbar = new Map((r.porProbar || []).map((p) => [p.idLugar, p.fecha]));
    // Las listas que se seguían solo en este teléfono pasan al servidor una vez.
    const viejas = leerLocal(CLAVE_SEGUIDAS_VIEJA, null);
    seguidas = new Set(r.seguidas || []);
    // Los votos de todos tus teléfonos: así no se vota dos veces por el mismo sitio
    (r.votados || []).forEach((id) => votados.add(id));
    guardarLocal(CLAVE_VOTADOS, Array.from(votados));
    // Mis cuatro: con cuenta viven en el servidor (así tus amigos los ven)
    if (tokenSesion) {
      if (Array.isArray(r.cuatro) && r.cuatro.some(Boolean)) { cuatro = r.cuatro; guardarLocal(CLAVE_CUATRO, cuatro); }
      else if (cuatro.some(Boolean)) guardarCuatroServidor();
    }
    if (Array.isArray(viejas) && viejas.length) {
      viejas.forEach((id) => { if (!seguidas.has(id)) { seguidas.add(id); pedir('/api/seguir', { idDispositivo, idLista: id }).catch(() => {}); } });
      guardarLocal(CLAVE_SEGUIDAS_VIEJA, null);
    }
    guardarDiario();
    repintar();
  } catch { /* se queda la copia del teléfono */ }
}

// ---------------- Navegación entre vistas ----------------
function irA(nombre) {
  if (mapaGrande) cerrarMapaGrande();
  cerrarHojas();
  vista = nombre;
  document.querySelectorAll('.vista').forEach((v) => { v.hidden = v.dataset.vista !== nombre; });
  document.querySelectorAll('.nav [data-vista]').forEach((b) => {
    if (b.dataset.vista === nombre) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (nombre === 'inicio' && mapa) setTimeout(() => mapa.resize(), 50);
  if (nombre === 'actividad') { cargarActividad(); guardarLocal(CLAVE_ACTIVIDAD_VISTA, Date.now()); $('punto-actividad').hidden = true; }
  repintar();
}
function repintar() {
  pintarAvatarInicio();
  if (vista === 'inicio') { pintarInicio(); pintarBuscar(); }
  else if (vista === 'actividad') pintarActividad();
  else if (vista === 'perfil') pintarPerfil();
  if (lugarAbierto && $('hoja-lugar').classList.contains('abierta')) pintarLugar();
}
// ---------------- Avatares ----------------
const PERSONAJES = [['oso', 'Oso'], ['zorro', 'Zorro'], ['perro', 'Perro caliente'], ['coneja', 'Coneja'], ['gata', 'Gata']];
const GESTOS = ['Tranquilo', 'Antojado'];
const FONDOS = { mostaza: '#F2C230', salvia: '#A9BE95', naranja: '#F0A872', arena: '#F1D6B8', rojo: '#E7826F' };
const NOMBRES_FONDO = { mostaza: 'Mostaza', salvia: 'Salvia', naranja: 'Durazno', arena: 'Arena', rojo: 'Tomate' };
function imgCara(av) { return '/img/av-' + av.p + '-' + av.g + '-cara.webp'; }
/** Círculo con la cara del personaje, o la inicial si todavía no lo eligió. */
function circulo(clase, av, nombre) {
  if (av) return '<span class="' + clase + ' con-cara" style="background:' + FONDOS[av.f] + '" aria-hidden="true"><img src="' + imgCara(av) + '" alt="" loading="lazy"></span>';
  return '<span class="' + clase + '" aria-hidden="true">' + escapar((nombre || '?').charAt(0).toUpperCase()) + '</span>';
}
function verAmigos() {
  const amigos = (yoDatos && yoDatos.amigos) || [];
  abrirElegir('Tus amigos', amigos.map((a) => ({ id: a.id, texto: a.nombre,
    html: '<li class="fila-sitio"><button type="button" class="abrir" data-accion="abrir-amigo" data-id="' + escapar(a.id) + '">' + circulo('inicial', a.avatar, a.nombre) +
      '<span><strong>' + escapar(a.nombre) + (a.usuario ? ' <span style="font-weight:500;color:var(--gris)">@' + escapar(a.usuario) + '</span>' : '') + '</strong><small>' + (function (n) { return n + (n === 1 ? ' probado' : ' probados'); })(Object.keys(a.probados || {}).length) + (a.avatar && a.avatar.frase ? ' · “' + escapar(a.avatar.frase) + '”' : '') + '</small></span></button></li>' })), null,
    amigos.length ? '' : '<p class="vacio">Todavía no tienes amigos aquí. Invítalos desde Actividad.</p>' +
    '<button type="button" class="principal" data-accion="invitar">Invitar a un amigo</button>');
}
function abrirEditorAvatar() {
  const p = yoDatos && yoDatos.perfil;
  if (!p) return;
  const b = Object.assign({ p: 'oso', g: 0, f: 'mostaza', frase: '' }, p.avatar || {});
  abrirElegir('Tu personaje', [], null, '<div id="av-editor"></div>');
  const caja = $('av-editor');
  function pinta() {
    caja.innerHTML =
      '<div class="av-escena" style="background:' + FONDOS[b.f] + '"><img src="/img/av-' + b.p + '-' + b.g + '.webp" alt="' + escapar(PERSONAJES.find((x) => x[0] === b.p)[1]) + ', ' + GESTOS[b.g].toLowerCase() + '"></div>' +
      '<p class="av-titulo">Personaje</p><div class="av-opciones">' + PERSONAJES.map(([k, t]) =>
        '<button type="button" data-av-p="' + k + '" aria-pressed="' + (b.p === k) + '"><span class="bola" style="background:' + FONDOS[b.f] + '"><img src="' + imgCara({ p: k, g: 0 }) + '" alt=""></span>' + t + '</button>').join('') + '</div>' +
      '<p class="av-titulo">Gesto</p><div class="av-opciones" style="justify-content:flex-start;gap:14px">' + GESTOS.map((t, i) =>
        '<button type="button" data-av-g="' + i + '" aria-pressed="' + (b.g === i) + '"><span class="bola" style="background:' + FONDOS[b.f] + '"><img src="' + imgCara({ p: b.p, g: i }) + '" alt=""></span>' + t + '</button>').join('') + '</div>' +
      '<p class="av-titulo">Color del círculo</p><div class="av-colores">' + Object.keys(FONDOS).map((k) =>
        '<button type="button" data-av-f="' + k + '" aria-pressed="' + (b.f === k) + '" aria-label="' + NOMBRES_FONDO[k] + '" style="background:' + FONDOS[k] + '"></button>').join('') + '</div>' +
      '<label class="campo" style="margin-top:18px">Tu frase <span class="opcional">(opcional)</span><input id="av-frase" type="text" maxlength="60" placeholder="Mi antojo: buñuelo con chocolate" value="' + escapar(b.frase) + '"></label>' +
      '<p id="av-error" class="error-campo" hidden></p><button type="button" class="principal" id="av-guardar">Guardar</button>';
  }
  pinta();
  caja.addEventListener('input', (e) => { if (e.target.id === 'av-frase') b.frase = e.target.value; });
  caja.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.avP) { b.p = t.dataset.avP; pinta(); }
    else if (t.dataset.avG) { b.g = Number(t.dataset.avG); pinta(); }
    else if (t.dataset.avF) { b.f = t.dataset.avF; pinta(); }
    else if (t.id === 'av-guardar') {
      t.disabled = true;
      const r = await pedir('/api/avatar', { avatar: { p: b.p, g: b.g, f: b.f, frase: b.frase.trim() } }).catch(() => null);
      if (!r || !r.ok) { t.disabled = false; $('av-error').textContent = (r && r.mensaje) || 'No pudimos guardar. Revisa tu conexión.'; $('av-error').hidden = false; return; }
      yoDatos.perfil.avatar = r.avatar;
      cerrarElegir(); pintarAvatarInicio(); repintar(); avisar('Listo, así te ven tus amigos.');
    }
  });
}
function pintarAvatarInicio() {
  const p = yoDatos && yoDatos.perfil;
  const av = $('inicio-avatar');
  av.classList.toggle('con-cara', !!(p && p.avatar));
  av.style.background = p && p.avatar ? FONDOS[p.avatar.f] : '';
  if (p && p.avatar) av.innerHTML = '<img src="' + imgCara(p.avatar) + '" alt="">';
  else if (p) av.textContent = (p.nombre || '?').charAt(0).toUpperCase();
  else av.innerHTML = '<img src="/img/oso-cabeza.webp" alt="" style="width:28px;height:28px;object-fit:contain">';
  // El botón Perfil de la barra usa la misma cara que el círculo de arriba
  const nc = $('nav-cara');
  nc.classList.toggle('con-cara', !!(p && p.avatar));
  nc.style.background = p && p.avatar ? FONDOS[p.avatar.f] : '';
  nc.innerHTML = p && p.avatar ? '<img src="' + imgCara(p.avatar) + '" alt="">'
    : p ? '<svg aria-hidden="true"><use href="#i-perfil"/></svg>' : '<img src="/img/oso-cabeza.webp" alt="" style="object-fit:contain">';
}

// ---------------- Marca, aliado y enlaces legales ----------------
function pintarMarca() {
  const a = CONFIG.aliado;
  const logo = a ? (a.logo ? '<img src="' + escapar(a.logo) + '" alt="' + escapar(a.nombre) + '">' : '<strong>' + escapar(a.nombre) + '</strong>') : '';
  const conEnlace = a && a.url ? '<a href="' + escapar(a.url) + '" target="_blank" rel="noopener sponsored">' + logo + '</a>' : logo;
  document.querySelectorAll('[data-aliado]').forEach((el) => { el.hidden = !a; el.innerHTML = conEnlace; });
  document.querySelectorAll('[data-aliado-linea]').forEach((el) => { el.hidden = !a; el.innerHTML = a ? '<span>Con el apoyo de</span>' + conEnlace : ''; });
  const legal = CONFIG.legal || {};
  document.querySelectorAll('[data-legal]').forEach((el) => { if (legal[el.dataset.legal]) el.href = legal[el.dataset.legal]; });
}
function urlPolitica() { return (CONFIG.legal && CONFIG.legal.politica) || 'https://www.elespectador.com/terminos/politica-de-tratamiento-de-datos/'; }

// ---------------- Hojas ----------------
function abrirHoja(id) {
  document.querySelectorAll('.hoja.abierta').forEach((h) => { if (h.id !== id && h.id !== 'hoja-elegir') h.classList.remove('abierta'); });
  const h = $(id);
  h.classList.add('abierta');
  h.scrollTop = 0;
  if (h.classList.contains('completa')) document.body.classList.add('hoja-completa');
  else $('velo').classList.add('visible');
}
function cerrarHojas() {
  document.querySelectorAll('.hoja.abierta').forEach((h) => h.classList.remove('abierta'));
  $('velo').classList.remove('visible');
  document.body.classList.remove('hoja-completa');
  if (lugarAbierto && marcadores.get(lugarAbierto.id)) marcadores.get(lugarAbierto.id).activar(false);
  lugarAbierto = null;
  if (fantasma) { fantasma.remove(); fantasma = null; }
  puntoNuevo = null;
}
function cerrarElegir() {
  $('hoja-elegir').classList.remove('abierta');
  if (!document.querySelector('.hoja.abierta:not(.completa)')) $('velo').classList.remove('visible');
}
function hayHojaAbierta() { return !!document.querySelector('.hoja.abierta'); }

// ---------------- Mapa ----------------
function calentarEstilo() {
  const estilo = mapa.getStyle();
  const capas = (estilo && estilo.layers) || [];
  const pintar = (id, prop, valor) => { try { mapa.setPaintProperty(id, prop, valor); } catch {} };
  const ocultar = (id) => { try { mapa.setLayoutProperty(id, 'visibility', 'none'); } catch {} };
  capas.forEach((c) => {
    const id = c.id.toLowerCase();
    const fuente = (c['source-layer'] || '').toLowerCase();
    if (c.type === 'background') pintar(c.id, 'background-color', '#F6EEDD');
    else if (c.type === 'fill') {
      if (fuente === 'water') pintar(c.id, 'fill-color', '#C9D6CF');
      else if (fuente === 'park' || fuente === 'landcover') pintar(c.id, 'fill-color', '#D6D8BC');
      else if (fuente === 'building') { pintar(c.id, 'fill-color', '#DCD5C1'); pintar(c.id, 'fill-outline-color', '#D0C8B2'); }
      else if (fuente === 'landuse' || fuente === 'aeroway') pintar(c.id, 'fill-color', '#E3DDCB');
    }
    else if (c.type === 'fill-extrusion' || c.type === 'hillshade') ocultar(c.id);
    else if (c.type === 'line') {
      if (fuente === 'transportation') {
        if (/rail|transit|subway|tram|ferry/.test(id)) pintar(c.id, 'line-color', '#CFC6B1');
        else if (/casing|outline/.test(id)) pintar(c.id, 'line-color', '#DCD5C1');
        else if (/motorway|highway|trunk|primary|major/.test(id)) pintar(c.id, 'line-color', '#F6DD8E');
        else pintar(c.id, 'line-color', '#F8F5EC');
      }
      else if (fuente === 'waterway') pintar(c.id, 'line-color', '#C9D6CF');
      else if (fuente === 'boundary') pintar(c.id, 'line-color', '#CFC6B1');
    }
    else if (c.type === 'symbol') {
      if (['poi', 'housenumber', 'aerodrome_label', 'mountain_peak'].indexOf(fuente) >= 0) { ocultar(c.id); return; }
      pintar(c.id, 'text-color', fuente === 'place' ? '#312A20' : '#5F574A');
      pintar(c.id, 'text-halo-color', '#F5F1E6');
    }
  });
}

class MarcadorBunuelo {
  constructor(lugar) {
    this.lugar = lugar;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'marcador';
    b.innerHTML = '<span class="cuerpo"><svg viewBox="0 0 100 100" aria-hidden="true"><use href="#bunuelo"/></svg></span><span class="cuenta"></span>';
    b.addEventListener('click', (e) => { e.stopPropagation(); ultimoToqueMarcador = Date.now(); abrirLugar(this.lugar.id); });
    this.el = b;
    this.marker = new maptilersdk.Marker({ element: b, anchor: 'center' }).setLngLat([lugar.lng, lugar.lat]).addTo(mapa);
    this.pintar();
  }
  actualizar(lugar) { this.lugar = lugar; this.marker.setLngLat([lugar.lng, lugar.lat]); this.pintar(); }
  pintar() {
    const v = this.lugar.votos;
    this.el.style.setProperty('--s', tamano(v) + 'px');
    this.el.style.zIndex = String(100 + v);
    this.el.setAttribute('aria-label', this.lugar.nombre + ', ' + v + (v === 1 ? ' voto' : ' votos'));
    const cuenta = this.el.querySelector('.cuenta');
    cuenta.textContent = v;
    cuenta.style.display = v >= 2 ? '' : 'none';
  }
  rebotar() { this.el.classList.remove('rebota'); void this.el.offsetWidth; this.el.classList.add('rebota'); }
  activar(si) { this.el.classList.toggle('activo', si); }
  quitar() { this.marker.remove(); }
}
function sincronizarMarcadores() {
  if (!mapaListo) return;
  const vivos = new Set();
  lugares.forEach((l) => {
    vivos.add(l.id);
    const m = marcadores.get(l.id);
    if (m) m.actualizar(l); else marcadores.set(l.id, new MarcadorBunuelo(l));
  });
  marcadores.forEach((m, id) => { if (!vivos.has(id)) { m.quitar(); marcadores.delete(id); } });
  aplicarAtenuado();
}
function filtroPrecioActivo() { return vista === 'inicio' && subInicio === 'cerca' && filtroPrecio !== 'todos'; }
function idsVisibles() {
  if (resaltado) return resaltado.ids;
  if (filtroPrecioActivo()) { const r = rangoActual(); return new Set(lugares.filter((l) => enRango(l, r)).map((l) => l.id)); }
  return null;
}
function aplicarAtenuado() {
  const visibles = idsVisibles();
  marcadores.forEach((m, id) => m.el.classList.toggle('atenuado', !!visibles && !visibles.has(id)));
  if (!$('chip-resaltado')) return;
  let texto = '';
  if (resaltado) texto = 'Viendo: ' + resaltado.titulo;
  else if (filtroPrecioActivo()) texto = 'Precio: ' + rangoActual().etiqueta;
  $('chip-resaltado').hidden = !texto;
  $('chip-texto').textContent = texto;
}
function quitarChip() {
  if (resaltado) resaltado = null;
  else { filtroPrecio = 'todos'; guardarLocal(CLAVE_FILTRO, filtroPrecio); }
  aplicarAtenuado();
  repintar();
}
function guardarLugar(l) {
  if (!l) return;
  const i = lugares.findIndex((x) => x.id === l.id);
  if (i >= 0) lugares[i] = l; else lugares.push(l);
  sincronizarMarcadores();
}

const ESCRITORIO = window.matchMedia('(min-width: 960px)');
const huecoMapa = $('mapa-caja').nextElementSibling;   // para devolverlo a Inicio en el celular
/** En computador el mapa vive fijo a la derecha, siempre abierto y tocable. */
function acomodarMapa() {
  const caja = $('mapa-caja');
  if (ESCRITORIO.matches) {
    if (caja.parentNode !== document.body) document.body.appendChild(caja);
    caja.classList.remove('grande');
    document.body.classList.remove('mapa-abierto');
    mapaGrande = true;
    if (mapa) { mapa.dragPan.enable(); mapa.scrollZoom.enable(); mapa.touchZoomRotate.enable(); mapa.doubleClickZoom.enable(); }
  } else {
    if (caja.parentNode !== huecoMapa.parentNode) huecoMapa.parentNode.insertBefore(caja, huecoMapa);
    mapaGrande = false;
    modoMapaPequeno();
  }
  if (mapa) setTimeout(() => mapa.resize(), 30);
}
if (ESCRITORIO.addEventListener) ESCRITORIO.addEventListener('change', acomodarMapa);
function abrirMapaGrande() {
  if (!mapa) return;
  if (ESCRITORIO.matches) { mapaGrande = true; return; }
  mapaGrande = true;
  $('mapa-caja').classList.add('grande');
  document.body.classList.add('mapa-abierto');
  mapa.dragPan.enable(); mapa.scrollZoom.enable(); mapa.touchZoomRotate.enable(); mapa.doubleClickZoom.enable();
  setTimeout(() => mapa.resize(), 30);
}
function cerrarMapaGrande() {
  if (ESCRITORIO.matches) { cerrarHojas(); return; }
  mapaGrande = false;
  cerrarHojas();
  $('mapa-caja').classList.remove('grande');
  document.body.classList.remove('mapa-abierto');
  modoMapaPequeno();
  setTimeout(() => mapa && mapa.resize(), 30);
}
function modoMapaPequeno() {
  if (!mapa || ESCRITORIO.matches) return;
  mapa.dragPan.disable(); mapa.scrollZoom.disable(); mapa.touchZoomRotate.disable(); mapa.doubleClickZoom.disable();
}

function volarA(lugar) {
  if (!mapa) { abrirLugar(lugar.id); return; }
  if (vista !== 'inicio') irA('inicio');
  if (!mapaGrande) abrirMapaGrande();
  cerrarHojas();
  mapa.flyTo({ center: [lugar.lng, lugar.lat], zoom: Math.max(mapa.getZoom(), 16), offset: [0, esMovil() ? -Math.round(window.innerHeight * 0.2) : 0], speed: 1.4, essential: true });
  alTerminarMovimiento(() => { abrirLugar(lugar.id); const m = marcadores.get(lugar.id); if (m) m.rebotar(); });
}
function alTerminarMovimiento(fn) {
  let hecho = false;
  const una = () => { if (!hecho) { hecho = true; fn(); } };
  mapa.once('moveend', una);
  setTimeout(una, 2500);
}
function masCercano(lat, lng) {
  let cercano = null, menor = Infinity;
  lugares.forEach((l) => { const d = distanciaMetros(lat, lng, l.lat, l.lng); if (d < menor) { menor = d; cercano = l; } });
  return cercano ? { lugar: cercano, distancia: menor } : null;
}
function pedirUbicacion() {
  return new Promise((resolver, rechazar) => {
    if (!navigator.geolocation) { rechazar({ code: 0 }); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      ultimaPosicion = { lat: pos.coords.latitude, lng: pos.coords.longitude, precision: Math.round(pos.coords.accuracy || 0), cuando: Date.now() };
      resolver(ultimaPosicion);
    }, rechazar, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}
function errorUbicacion(err) {
  if (err && err.code === 1) return 'No tenemos permiso para ver tu ubicación. Actívalo en el navegador o toca el mapa en el sitio.';
  if (err && err.code === 0) return 'Este navegador no comparte tu ubicación. Toca el mapa en el sitio del buñuelo.';
  return 'No pudimos encontrar tu ubicación. Toca el mapa en el sitio del buñuelo.';
}
async function ubicarme() {
  if (!mapaListo) return;
  if (!mapaGrande) abrirMapaGrande();
  const boton = $('boton-ubicacion'), texto = $('boton-ubicacion-texto');
  boton.disabled = true; boton.classList.add('buscando'); texto.textContent = 'Buscándote…';
  let pos;
  try { pos = await pedirUbicacion(); }
  catch (err) { avisar(errorUbicacion(err), 'error'); return; }
  finally { boton.disabled = false; boton.classList.remove('buscando'); texto.textContent = 'Estoy aquí'; }
  if (!dentroDeBogota(pos.lat, pos.lng)) { avisar('Parece que no estás en Bogotá. Busca tu buñuelo en el mapa y tócalo.'); return; }
  cerrarHojas();
  mapa.flyTo({ center: [pos.lng, pos.lat], zoom: Math.max(mapa.getZoom(), 17), offset: [0, esMovil() ? -Math.round(window.innerHeight * 0.22) : 0], speed: 1.6, essential: true });
  alTerminarMovimiento(() => {
    const c = masCercano(pos.lat, pos.lng);
    if (c && c.distancia < CONFIG.distanciaDuplicado) { abrirLugar(c.lugar.id, true); const m = marcadores.get(c.lugar.id); if (m) m.rebotar(); }
    else abrirNuevo(pos.lat, pos.lng, pos.precision);
  });
}
function alTocarMapa(e) {
  if (Date.now() - ultimoToqueMarcador < 400) return;
  if (!mapaGrande) { abrirMapaGrande(); return; }
  if (hayHojaAbierta()) { cerrarHojas(); return; }
  const lat = e.lngLat.lat, lng = e.lngLat.lng;
  if (!dentroDeBogota(lat, lng)) { avisar('Ese punto queda por fuera de Bogotá. Busca tu buñuelo dentro de la ciudad.'); return; }
  const c = masCercano(lat, lng);
  if (c && c.distancia < CONFIG.distanciaDuplicado) { abrirLugar(c.lugar.id, true); const m = marcadores.get(c.lugar.id); if (m) m.rebotar(); return; }
  abrirNuevo(lat, lng);
}

// ---------------- Inicio ----------------
function pintarInicio() {
  document.querySelectorAll('[data-accion="sub-inicio"]').forEach((b) => {
    const on = b.dataset.sub === subInicio;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on));
  });
  const caja = $('inicio-contenido');
  if (subInicio === 'top') caja.innerHTML = htmlTop();
  else if (subInicio === 'cerca') caja.innerHTML = htmlCerca();
  else caja.innerHTML = htmlListas();
  aplicarAtenuado();
}
function corazon(id) {
  const on = porProbar.has(id);
  const l = lugarPorId(id);
  return '<button type="button" class="corazon" data-accion="por-probar" data-id="' + escapar(id) + '" aria-pressed="' + on + '" aria-label="' +
    (on ? 'Quitar ' : 'Agregar ') + escapar(l ? l.nombre : '') + (on ? ' de Por probar' : ' a Por probar') + '"><svg aria-hidden="true"><use href="#i-corazon"/></svg></button>';
}
function htmlTop() {
  const top = ordenados().slice(0, 10);
  if (!top.length) return '<p class="vacio">Todavía no hay buñuelos. Abre el mapa y marca el primero.</p>';
  const cuenta = (n, uno, varios) => n + ' ' + (n === 1 ? uno : varios);
  return '<div class="como-se-calcula"><span>Ordenado por puntaje</span><button type="button" data-accion="como-se-calcula"><svg aria-hidden="true"><use href="#i-info"/></svg>¿Cómo se calcula?</button></div>' +
    '<ul class="tarjetas">' + top.map((l, i) => {
      const [z, zonaTexto] = zona(l);
      return '<li class="tarjeta-sitio z-' + z + (i < 3 ? ' p' + (i + 1) : '') + '">' + corazon(l.id) +
      '<button type="button" class="abrir" data-accion="abrir-lugar" data-id="' + escapar(l.id) + '">' +
        '<span class="encabezado"><span class="puesto" aria-label="Puesto ' + (i + 1) + '">' + (i + 1) + '</span><span class="nombre">' + escapar(l.nombre) + '</span></span>' +
        '<span class="foto">' + bun() + '<span class="zona">' + zonaTexto + '</span></span>' +
        '<span class="datos"><span>' + escapar(l.barrio || 'Bogotá') + '</span><strong>' + (tienePrecio(l) ? escapar(formatoPrecio(l.precio)) : '') + '</strong></span>' +
        (l.nota ? '<span class="datos">' + calHtml(Math.round(l.nota * 2) / 2, 16) + '<span>' + formatoCal(l.nota) + '</span></span>' : '<span class="datos"><span>Sin notas todavía</span></span>') +
        '<span class="datos"><span>' + cuenta(l.votos, 'voto', 'votos') + (l.opiniones ? ' · ' + cuenta(l.opiniones, 'nota', 'notas') : '') + '</span></span>' +
      '</button></li>';
    }).join('') + '</ul>';
}
function explicarRanking() {
  abrirElegir('¿Cómo se calcula el Top 10?', [], null, '<div class="explica">' +
    '<p>Cada sitio tiene un <strong>puntaje</strong> que mezcla dos cosas: qué tan bien lo califica la gente y cuánta gente lo ha hecho.</p>' +
    '<p>• Cada calificación cuenta con su nota, de medio a 5 buñuelos. Si alguien calificó varias veces el mismo sitio, vale la última.<br>' +
    '• Cada voto de «¡Este es el mejor!» cuenta como un 5.<br>' +
    '• A todos los sitios les sumamos ' + CONFIANZA + ' opiniones con la nota media de Bogotá. Así, un sitio con dos 5 no le gana a otro con cincuenta opiniones de 4,8: necesita más gente que lo respalde.</p>' +
    '<p class="formula">Por eso puedes ver un sitio con 4,9 por encima de uno con 5,0: el primero tiene más opiniones detrás.</p>' +
    '<p style="margin:0">La nota que ves en cada tarjeta es el promedio de las calificaciones, sin ajustes.</p></div>');
}
function origenCerca() {
  if (ultimaPosicion && Date.now() - ultimaPosicion.cuando < 10 * 60000) return { lat: ultimaPosicion.lat, lng: ultimaPosicion.lng, gps: true };
  const c = mapa ? mapa.getCenter() : { lat: 4.655, lng: -74.09 };
  return { lat: c.lat, lng: c.lng, gps: false };
}
function formatoDistancia(m) {
  const lejos = m < 1000 ? 'a ' + (Math.round(m / 10) * 10) + ' m' : 'a ' + (m / 1000).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' km';
  const minutos = Math.max(1, Math.round(m / 75));
  return minutos <= 30 ? lejos + ' (' + minutos + ' min a pie)' : lejos;
}
function filaSitio(l, extra, conLlegar) {
  return '<li class="fila-sitio"><button type="button" class="abrir" data-accion="abrir-lugar" data-id="' + escapar(l.id) + '">' +
    '<span class="mini">' + bun() + '</span><span><strong>' + escapar(l.nombre) + '</strong><small>' + extra + '</small></span></button>' +
    (conLlegar ? '<a class="llegar" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&amp;travelmode=walking&amp;destination=' + encodeURIComponent(l.lat + ',' + l.lng) + '">Cómo llegar</a>' : '') +
    '</li>';
}
function htmlCerca() {
  const o = origenCerca();
  const rango = rangoActual();
  const conFiltro = rango.id !== 'todos';
  const yaProbe = ultimas();
  let h = '<div class="pastillas" role="group" aria-label="Filtrar por precio">' + RANGOS_PRECIO.map((r) =>
    '<button type="button" class="pastilla' + (r.id === filtroPrecio ? ' on' : '') + '" data-accion="rango" data-rango="' + r.id + '" aria-pressed="' + (r.id === filtroPrecio) + '">' + escapar(r.etiqueta) + '</button>').join('') + '</div>';
  h += '<div class="fila entre" style="margin:12px 0"><p class="sub" style="margin:0">' +
    (conFiltro ? 'Buñuelos ' + rango.frase + ', del más cercano al más lejano.' : (o.gps ? 'Cerca de donde estás. Primero los que no has probado.' : 'Cerca del centro del mapa. Con tu ubicación es más exacto.')) + '</p>' +
    (o.gps ? '' : '<button type="button" class="secundario" data-accion="ubicar-cerca" style="min-height:40px;padding:0 14px">Usar mi ubicación</button>') + '</div>';
  const todos = lugares.map((l) => ({ l, m: distanciaMetros(o.lat, o.lng, l.lat, l.lng) }));
  let lista;
  if (conFiltro) {
    lista = todos.filter((x) => enRango(x.l, rango)).sort((a, b) => a.m - b.m).slice(0, 10);
    if (!lista.length) return h + '<p class="vacio">Todavía no hay buñuelos marcados ' + escapar(rango.frase) + '. Si conoces uno, márcalo en el mapa con su precio.</p>';
  } else {
    let cand = todos.filter((x) => x.m <= 4000);
    if (cand.length < 3) cand = todos.slice().sort((a, b) => a.m - b.m).slice(0, 5);
    cand.forEach((x) => { x.p = (x.l.votos + 1) / Math.pow(0.3 + x.m / 1000, 1.2) * (yaProbe.has(x.l.id) ? 0.35 : 1); });
    lista = cand.sort((a, b) => b.p - a.p).slice(0, 6);
    if (!lista.length) return h + '<p class="vacio">No hay buñuelos marcados por aquí. ¿Conoces alguno? Ábrelo en el mapa y agrégalo.</p>';
  }
  const masVotado = lista.reduce((a, b) => (b.l.votos > a.l.votos ? b : a));
  const masCerca = lista.reduce((a, b) => (b.m < a.m ? b : a));
  return h + '<ul class="filas">' + lista.map((x) => {
    const l = x.l;
    let razon = '';
    if (yaProbe.has(l.id)) razon = 'Ya lo probaste';
    else if (porProbar.has(l.id)) razon = 'Lo tienes en Por probar';
    else if (x === masVotado && l.votos > 0) razon = 'El más votado de la zona';
    else if (x === masCerca) razon = 'El que te queda más cerca';
    return filaSitio(l, escapar(formatoDistancia(x.m)) + (tienePrecio(l) ? ' · ' + escapar(formatoPrecio(l.precio)) : '') + (razon ? '<br><span class="razon">' + razon + '</span>' : ''), true);
  }).join('') + '</ul>';
}
function iniciales(texto) {
  const p = String(texto || '').split(/\s+/).filter((w) => w && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(w[0]) && w.length >= 2);
  return p.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '★';
}
function lugaresDeLista(li) { return li.ids.map(lugarPorId).filter(Boolean); }
function botonSeguir(li) {
  const si = seguidas.has(li.id);
  return '<button type="button" class="seguir" data-accion="seguir" data-id="' + escapar(li.id) + '" aria-pressed="' + si + '">' + (si ? 'Siguiendo' : 'Seguir') + '</button>';
}
function htmlListas() {
  const abierta = listaAbierta && listas.find((li) => li.id === listaAbierta);
  if (abierta) return htmlDetalleLista(abierta);
  if (!listas.length) return oso('senala') + '<p class="vacio" style="text-align:center">Pronto vas a encontrar aquí las listas de invitados: sus buñuelos favoritos, en orden.</p>';
  const ord = listas.slice().sort((a, b) => (seguidas.has(b.id) - seguidas.has(a.id)) || ((a.estado === 'proximamente') - (b.estado === 'proximamente')) || (a.orden - b.orden));
  return '<ul class="filas">' + ord.map((li) => {
    const pronto = li.estado === 'proximamente', n = lugaresDeLista(li).length;
    return '<li class="tarjeta-lista"><button type="button" class="abrir" data-accion="abrir-lista" data-id="' + escapar(li.id) + '">' +
      '<span class="portada' + (pronto ? ' pronto' : '') + '" aria-hidden="true">' + escapar(iniciales(li.autor)) + '</span>' +
      '<span><strong>' + escapar(li.titulo) + '</strong><small>' + escapar(li.autor) + (pronto ? '' : ' · ' + n + (n === 1 ? ' sitio' : ' sitios')) + '</small>' +
      (pronto ? '<span class="etiqueta">Muy pronto</span>' : '') + '</span></button>' + botonSeguir(li) + '</li>';
  }).join('') + '</ul>';
}
function htmlDetalleLista(li) {
  const sitios = lugaresDeLista(li), pronto = li.estado === 'proximamente';
  return '<div class="detalle-lista"><button type="button" class="enlace" data-accion="volver-listas">← Todas las listas</button>' +
    '<h3>' + escapar(li.titulo) + '</h3><p class="autor">' + escapar(li.autor) + '</p>' +
    (li.descripcion ? '<p class="desc">' + escapar(li.descripcion) + '</p>' : '') +
    '<div class="acciones">' + (sitios.length ? '<button type="button" class="secundario" data-accion="lista-mapa" data-id="' + escapar(li.id) + '">Ver en el mapa</button>' : '') + botonSeguir(li) + '</div>' +
    (pronto ? '<p class="desc">Cuando llegue su selección, la verás aquí' + (seguidas.has(li.id) ? ' de primeras.' : '. Síguela para tenerla de primeras.') + '</p>'
      : (sitios.length ? '<ol class="filas" style="margin-top:14px">' + sitios.map((l, i) => filaSitio(l, (i + 1) + '. ' + escapar(l.barrio || 'Bogotá') + (tienePrecio(l) ? ' · ' + escapar(formatoPrecio(l.precio)) : ''))).join('') + '</ol>'
        : '<p class="desc">Esta lista todavía no tiene sitios en el mapa.</p>')) +
    (li.fuenteNombre ? '<p class="fuente">Fuente: ' + (li.fuenteUrl ? '<a href="' + escapar(li.fuenteUrl) + '" target="_blank" rel="noopener">' + escapar(li.fuenteNombre) + '</a>' : escapar(li.fuenteNombre)) + '</p>' : '') +
    '</div>';
}
function verListaEnMapa(id) {
  const li = listas.find((x) => x.id === id);
  if (!li || !mapa) return;
  const sitios = lugaresDeLista(li);
  if (!sitios.length) return;
  resaltado = { titulo: li.titulo, ids: new Set(sitios.map((l) => l.id)) };
  abrirMapaGrande();
  aplicarAtenuado();
  if (sitios.length === 1) { volarA(sitios[0]); return; }
  let o = 180, s = 90, e = -180, n = -90;
  sitios.forEach((l) => { o = Math.min(o, l.lng); e = Math.max(e, l.lng); s = Math.min(s, l.lat); n = Math.max(n, l.lat); });
  setTimeout(() => mapa.fitBounds([[o, s], [e, n]], { padding: { top: 140, bottom: 120, left: 50, right: 50 }, maxZoom: 15, duration: 1200 }), 60);
  sitios.forEach((l, i) => { const m = marcadores.get(l.id); if (m) setTimeout(() => m.rebotar(), 1400 + i * 120); });
}
async function alternarSeguir(id) {
  const li = listas.find((x) => x.id === id);
  if (!li || !exigirCuenta('seguir listas')) return;
  const quitar = seguidas.has(id);
  if (quitar) seguidas.delete(id); else seguidas.add(id);
  guardarDiario();
  repintar();
  avisar(quitar ? 'Dejaste de seguir “' + li.titulo + '”.' : (li.estado === 'proximamente' ? 'Listo. Cuando llegue, la verás de primeras.' : 'Sigues “' + li.titulo + '”.'));
  if (CON_SERVIDOR) pedir('/api/seguir', { idDispositivo, idLista: id, quitar }).then((r) => respuestaSinSesion(r, 'seguir listas')).catch(() => {});
}

/** Votar, anotar, guardar y seguir exigen cuenta. Sin sesión, lleva a crearla y avisa para qué. */
function exigirCuenta(para) {
  if (tokenSesion && yoDatos && yoDatos.perfil) return true;
  cerrarHojas();
  if (fantasma) { fantasma.remove(); fantasma = null; }
  modoCuenta = 'crear';
  irA('actividad');
  avisar('Crea tu cuenta o entra para ' + para + '. Toma un minuto.');
  return false;
}
/** Si el servidor dice que la sesión no sirve, se cierra aquí también y se pide entrar. */
function respuestaSinSesion(r, para) {
  if (!r || !r.sesion) return false;
  tokenSesion = ''; guardarLocal(CLAVE_SESION, null);
  yoDatos = { ok: true, activo: true, conectado: false };
  exigirCuenta(para);
  return true;
}

// ---------------- Tarjeta de un sitio ----------------
function abrirLugar(id, esDuplicado) {
  const l = lugarPorId(id);
  if (!l) return;
  if (lugarAbierto && marcadores.get(lugarAbierto.id)) marcadores.get(lugarAbierto.id).activar(false);
  if (fantasma) { fantasma.remove(); fantasma = null; }
  lugarAbierto = l;
  const m = marcadores.get(l.id);
  if (m) m.activar(true);
  $('l-aviso').hidden = !esDuplicado;
  pintarLugar();
  abrirHoja('hoja-lugar');
}
function pintarLugar() {
  const l = lugarAbierto = lugarPorId(lugarAbierto.id) || lugarAbierto;
  $('l-nombre').textContent = l.nombre;
  $('l-barrio').textContent = (l.barrio || 'Barrio sin dato') + ' · ' + formatoPrecio(l.precio);
  $('l-votos').textContent = l.votos;
  $('l-nota').textContent = l.nota ? formatoCal(l.nota) : '–';
  $('l-nota-sub').textContent = l.opiniones ? 'nota de ' + l.opiniones + (l.opiniones === 1 ? ' persona' : ' personas') : 'nota de la gente';
  const puesto = ordenados().findIndex((x) => x.id === l.id) + 1;
  $('l-puesto').textContent = puesto > 0 ? puesto + '.º' : '–';
  const ya = votados.has(l.id);
  const b = $('l-votar');
  b.disabled = ya; b.textContent = ya ? 'Ya votaste por este' : '¡Este es el mejor!';
  const enListas = listas.filter((li) => li.estado !== 'proximamente' && li.ids.indexOf(l.id) >= 0);
  $('l-listas').hidden = !enListas.length;
  $('l-listas').textContent = enListas.length ? 'En la lista: ' + enListas.map((li) => li.titulo).join(' · ') : '';
  const amigos = (yoDatos && yoDatos.amigos) || [];
  const notas = amigos.filter((a) => a.probados && a.probados[l.id]).map((a) => escapar(a.nombre) + ': ' + formatoCal(a.probados[l.id].cal));
  $('l-amigos').hidden = !notas.length;
  $('l-amigos').innerHTML = notas.length ? 'Tus amigos: ' + notas.join(' · ') : '';
  const mias = entradas.filter((e) => e.idLugar === l.id).sort((a, b) => b.fecha.localeCompare(a.fecha));
  $('l-mio').hidden = !mias.length;
  $('l-mio').textContent = mias.length ? 'Lo anotaste ' + (mias.length === 1 ? 'una vez' : mias.length + ' veces') + '. La última, el ' + fechaCorta(mias[0].fecha) + ': ' + formatoCal(mias[0].cal) + ' de 5.' : '';
  const pp = porProbar.has(l.id);
  $('l-porprobar').setAttribute('aria-pressed', String(pp));
  $('l-porprobar').textContent = pp ? 'En Por probar ✓' : 'Por probar';
  const n = l.probados || 0;
  $('l-probados').textContent = n === 0 ? 'Nadie lo ha anotado todavía' : (n === 1 ? '1 persona lo probó' : n + ' personas lo probaron');
  $('l-llegar').href = 'https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=' + encodeURIComponent(l.lat + ',' + l.lng);
}
async function votarAbierto() {
  const lugar = lugarAbierto;
  if (!lugar || votados.has(lugar.id) || !exigirCuenta('votar')) return;
  const b = $('l-votar');
  b.disabled = true; b.textContent = 'Contando tu voto…';
  try {
    const r = await pedir('/api/votar', { idLugar: lugar.id, idDispositivo, token: await tokenCaptcha() });
    if (respuestaSinSesion(r, 'votar')) return;
    if (r.ok || r.yaVoto) {
      marcarVotado(lugar.id);
      guardarLugar(r.lugar);
      if (r.ok) {
        celebrar();
        const m = marcadores.get(lugar.id); if (m) m.rebotar();
        avisar('¡Voto contado! ' + r.lugar.nombre + ' suma ' + r.lugar.votos + (r.lugar.votos === 1 ? ' voto.' : ' votos.'));
      } else avisar(r.mensaje);
    } else avisar(r.mensaje || 'No pudimos guardar tu voto. Intenta de nuevo.', 'error');
  } catch { avisar('No pudimos guardar tu voto. Revisa tu conexión e intenta de nuevo.', 'error'); }
  if (lugarAbierto) pintarLugar();
  if (vista === 'inicio') pintarInicio();
}
function celebrar() {
  const caja = $('l-foto');
  caja.classList.remove('rebota-tarjeta'); void caja.offsetWidth; caja.classList.add('rebota-tarjeta');
  const v = $('l-votos'); v.classList.remove('pop'); void v.offsetWidth; v.classList.add('pop');
}
async function alternarPorProbar(id) {
  const l = lugarPorId(id);
  if (!l || !exigirCuenta('guardar sitios en Por probar')) return;
  const quitar = porProbar.has(id);
  if (quitar) porProbar.delete(id); else porProbar.set(id, Date.now());
  guardarDiario();
  repintar();
  avisar(quitar ? 'Quitaste ' + l.nombre + ' de Por probar.' : 'Anotado en Por probar: ' + l.nombre + '.');
  if (CON_SERVIDOR) pedir('/api/por-probar', { idDispositivo, idLugar: id, quitar }).then((r) => respuestaSinSesion(r, 'guardar sitios en Por probar')).catch(() => {});
}

// ---------------- Sitio nuevo ----------------
function abrirNuevo(lat, lng, precision) {
  if (!exigirCuenta('agregar sitios al mapa')) return;
  cerrarHojas();
  puntoNuevo = { lat, lng };
  const el = document.createElement('div');
  el.className = 'fantasma';
  el.setAttribute('aria-label', 'Punto nuevo. Arrástralo para ajustarlo.');
  el.addEventListener('click', (e) => { e.stopPropagation(); ultimoToqueMarcador = Date.now(); });
  fantasma = new maptilersdk.Marker({ element: el, anchor: 'center', draggable: true }).setLngLat([lng, lat]).addTo(mapa);
  fantasma.on('dragstart', () => { ultimoToqueMarcador = Date.now(); });
  fantasma.on('dragend', () => { const p = fantasma.getLngLat(); puntoNuevo = { lat: p.lat, lng: p.lng }; ultimoToqueMarcador = Date.now(); });
  $('n-nota').textContent = (precision && precision > 60)
    ? 'Tu ubicación es aproximada (unos ' + precision + ' metros). Si el punto no quedó justo en el sitio, arrástralo en el mapa.'
    : 'Si el punto no quedó justo en el sitio, arrástralo en el mapa.';
  $('form-lugar').reset();
  $('n-error').hidden = true;
  $('n-guardar').disabled = false; $('n-guardar').textContent = 'Guardar y votar';
  abrirHoja('hoja-nuevo');
  if (!esMovil()) setTimeout(() => $('n-nombre').focus(), 300);
}
async function enviarNuevo(e) {
  e.preventDefault();
  const nombre = $('n-nombre').value.trim(), precio = $('n-precio').value.trim();
  const error = (t) => { $('n-error').textContent = t; $('n-error').hidden = false; };
  if (!nombre) { error('Escribe el nombre del sitio.'); $('n-nombre').focus(); return; }
  if (precio && !/^[\d.,\s]+$/.test(precio)) { error('Escribe el precio solo con números, por ejemplo 2500.'); return; }
  $('n-error').hidden = true;
  const b = $('n-guardar'); b.disabled = true; b.textContent = 'Guardando…';
  const punto = puntoNuevo;
  try {
    const r = await pedir('/api/lugares', { datos: { nombre, barrio: $('n-barrio').value.trim(), precio, lat: punto.lat, lng: punto.lng }, idDispositivo, token: await tokenCaptcha() });
    if (respuestaSinSesion(r, 'agregar sitios al mapa')) return;
    if (r.ok) {
      marcarVotado(r.lugar.id); guardarLugar(r.lugar);
      abrirLugar(r.lugar.id); celebrar();
      const m = marcadores.get(r.lugar.id); if (m) m.rebotar();
      avisar('¡Listo! Tu buñuelo ya está en el mapa.');
    } else if (r.duplicado) { guardarLugar(r.lugar); abrirLugar(r.lugar.id, true); }
    else { error(r.mensaje || 'No pudimos guardar el sitio. Intenta de nuevo.'); b.disabled = false; b.textContent = 'Guardar y votar'; }
  } catch { avisar('No pudimos guardar el sitio. Revisa tu conexión e intenta de nuevo.', 'error'); b.disabled = false; b.textContent = 'Guardar y votar'; }
}

// ---------------- Anotar ----------------
const anotacion = { modo: 'probe', idLugar: null, cal: 0, fecha: null, volveria: null, id: null };
function abrirAnotar(idLugar, entrada) {
  if (!exigirCuenta('anotar tus buñuelos')) return;
  cerrarHojas();
  Object.assign(anotacion, { modo: 'probe', idLugar: idLugar || null, cal: 0, fecha: hoyBogota(), volveria: null, id: null });
  $('a-resena').value = '';
  if (entrada) {
    Object.assign(anotacion, { idLugar: entrada.idLugar, cal: entrada.cal, fecha: entrada.fecha, volveria: entrada.volveria, id: entrada.id });
    $('a-resena').value = entrada.resena || '';
  }
  $('a-titulo').textContent = entrada ? 'Editar anotación' : 'Anotar un buñuelo';
  $('a-modo').hidden = !!entrada;
  $('a-borrar').hidden = !entrada;
  $('a-error').hidden = true;
  pintarAnotar();
  abrirHoja('hoja-anotar');
  if (!anotacion.idLugar) setTimeout(elegirSitioParaAnotar, 250);
}
function pintarAnotar() {
  const a = anotacion;
  document.querySelectorAll('[data-accion="modo-anotar"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.modo === a.modo)));
  const l = a.idLugar && lugarPorId(a.idLugar);
  $('a-sitio').innerHTML = l
    ? '<div class="sitio-elegido">' + bun() + '<div style="flex:1;min-width:0"><strong>' + escapar(l.nombre) + '</strong>' +
      '<span class="sub" style="display:block;margin:0">' + escapar(l.barrio || 'Bogotá') + ' · ' + escapar(formatoPrecio(l.precio)) + '</span></div>' +
      (a.id ? '' : '<button type="button" class="enlace" data-accion="elegir-sitio">Cambiar</button>') + '</div>'
    : '<button type="button" class="secundario" style="width:100%" data-accion="elegir-sitio">Elige el sitio</button>';
  $('a-formulario').hidden = a.modo !== 'probe';
  // puntaje
  let h = '';
  for (let i = 1; i <= 5; i++) {
    const lleno = a.cal >= i, medio = !lleno && a.cal >= i - 0.5;
    h += '<span class="celda"><svg class="apagado" viewBox="0 0 100 100" aria-hidden="true"><use href="#bunuelo"/></svg>' +
      (lleno || medio ? '<svg class="' + (medio ? 'medio' : '') + '" viewBox="0 0 100 100" aria-hidden="true"><use href="#bunuelo"/></svg>' : '') +
      '<button type="button" class="mitad izq" data-accion="cal" data-cal="' + (i - 0.5) + '" aria-label="' + formatoCal(i - 0.5) + ' buñuelos"></button>' +
      '<button type="button" class="mitad der" data-accion="cal" data-cal="' + i + '" aria-label="' + i + (i === 1 ? ' buñuelo' : ' buñuelos') + '"></button></span>';
  }
  h += '<span class="texto-cal">' + (a.cal ? formatoCal(a.cal) + ' · ' + textoCal(a.cal) : 'Toca o desliza') + '</span>';
  $('a-cal').innerHTML = h;
  $('a-cal-rango').value = a.cal || 0.5;
  $('a-cal-rango').classList.toggle('sin-valor', !a.cal);
  // fecha
  const hoy = hoyBogota(), ayer = hoyBogota(1);
  const otra = a.fecha !== hoy && a.fecha !== ayer;
  $('a-fecha').innerHTML =
    '<button type="button" class="pastilla' + (a.fecha === hoy ? ' on' : '') + '" data-accion="fecha" data-fecha="' + hoy + '" aria-pressed="' + (a.fecha === hoy) + '">Hoy</button>' +
    '<button type="button" class="pastilla' + (a.fecha === ayer ? ' on' : '') + '" data-accion="fecha" data-fecha="' + ayer + '" aria-pressed="' + (a.fecha === ayer) + '">Ayer</button>' +
    // "Otra fecha": la pastilla muestra la fecha elegida y el selector del sistema queda encima, invisible
    '<label class="pastilla fecha-otra' + (otra ? ' on' : '') + '">' + (otra ? fechaCorta(a.fecha) : 'Otra fecha') +
    '<input type="date" id="a-otra-fecha" max="' + hoy + '" min="2020-01-01" value="' + a.fecha + '" aria-label="Elegir otra fecha"></label>';
  const otraFecha = $('a-otra-fecha');
  otraFecha.addEventListener('change', (e) => { if (e.target.value && e.target.value <= hoy) { a.fecha = e.target.value; pintarAnotar(); } });
  otraFecha.addEventListener('click', () => { try { if (otraFecha.showPicker) otraFecha.showPicker(); } catch { /* algunos navegadores no lo permiten */ } });
  document.querySelectorAll('[data-accion="volveria"]').forEach((b) => {
    const on = (b.dataset.valor === 'si' && a.volveria === true) || (b.dataset.valor === 'no' && a.volveria === false);
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  $('a-contador').textContent = $('a-resena').value.length + ' / 500';
  const g = $('a-guardar');
  g.disabled = false;
  g.textContent = a.modo === 'porprobar' ? (l && porProbar.has(l.id) ? 'Ya está en Por probar' : 'Agregar a Por probar') : (a.id ? 'Guardar cambios' : '¡Sí, chef!');
  if (a.modo === 'porprobar' && l && porProbar.has(l.id)) g.disabled = true;
}
function elegirSitioParaAnotar() {
  const o = ultimaPosicion ? ultimaPosicion : null;
  const lista = lugares.slice().sort((a, b) => o ? distanciaMetros(o.lat, o.lng, a.lat, a.lng) - distanciaMetros(o.lat, o.lng, b.lat, b.lng) : (b.votos - a.votos));
  abrirElegir('¿Dónde comiste?', lista.map((l) => ({ id: l.id, texto: l.nombre + ' ' + (l.barrio || ''), html: filaSitioElegir(l) })), (id) => {
    anotacion.idLugar = id; pintarAnotar();
  }, '<p class="sub" style="margin:4px 0 12px">¿No está? <button type="button" class="enlace" data-accion="nuevo-desde-anotar">Márcalo en el mapa</button></p>');
}
function filaSitioElegir(l) {
  return '<li class="fila-sitio"><button type="button" class="abrir" data-accion="elegido" data-id="' + escapar(l.id) + '"><span class="mini">' + bun() + '</span><span><strong>' + escapar(l.nombre) + '</strong><small>' + escapar(l.barrio || 'Bogotá') + ' · ' + escapar(formatoPrecio(l.precio)) + '</small></span></button></li>';
}
async function guardarAnotacion() {
  const a = anotacion;
  const error = (t) => { $('a-error').textContent = t; $('a-error').hidden = false; };
  $('a-error').hidden = true;
  if (!a.idLugar) { error('Elige el sitio.'); return; }
  if (a.modo === 'porprobar') { await alternarPorProbar(a.idLugar); cerrarHojas(); return; }
  if (!a.cal) { error('Toca los buñuelos para decir qué tal estaba.'); return; }
  if (modoDemo) { avisar('Esto es una demostración: no se guarda.'); return; }
  const g = $('a-guardar'); g.disabled = true; g.textContent = 'Anotando…';
  try {
    const r = await pedir('/api/anotar', { id: a.id || undefined, idDispositivo, idLugar: a.idLugar, cal: a.cal, fecha: a.fecha, volveria: a.volveria, resena: $('a-resena').value.trim() });
    if (respuestaSinSesion(r, 'anotar tus buñuelos')) return;
    if (!r.ok) { error(r.mensaje || 'No pudimos anotarlo.'); pintarAnotar(); return; }
    const i = entradas.findIndex((e) => e.id === r.entrada.id);
    if (i >= 0) entradas[i] = r.entrada; else entradas.push(r.entrada);
    if (r.nueva) porProbar.delete(a.idLugar);
    guardarDiario();
    guardarLugar(r.lugar);
    cerrarHojas();
    const total = ultimas().size;
    avisar(r.nueva ? '¡Sí, chef! Anotado. Llevas ' + total + (total === 1 ? ' sitio probado.' : ' sitios probados.') : 'Listo, guardamos los cambios.');
    repintar();
  } catch { error('No pudimos anotarlo. Revisa tu conexión e intenta de nuevo.'); pintarAnotar(); }
}
async function borrarEntrada() {
  const b = $('a-borrar');
  if (b.dataset.confirmar !== '1') { b.dataset.confirmar = '1'; b.textContent = '¿Seguro? Toca otra vez para borrar'; return; }
  b.dataset.confirmar = ''; b.textContent = 'Borrar esta anotación';
  try {
    const r = await pedir('/api/entrada/borrar', { id: anotacion.id, idDispositivo });
    if (!r.ok) { avisar(r.mensaje || 'No pudimos borrarla.', 'error'); return; }
    entradas = entradas.filter((e) => e.id !== anotacion.id);
    guardarDiario(); guardarLugar(r.lugar);
    cerrarHojas(); avisar('Borramos esa anotación.'); repintar();
  } catch { avisar('No pudimos borrarla. Revisa tu conexión.', 'error'); }
}

// ---------------- Hoja para elegir ----------------
let alElegir = null;
function abrirElegir(titulo, items, fn, encabezado) {
  alElegir = fn;
  $('e-titulo').textContent = titulo;
  const buscar = items.length > 6
    ? '<label class="campo" style="margin-bottom:10px"><span class="oculto-visual">Filtrar</span><input id="e-filtro" type="search" placeholder="Escribe para filtrar" autocomplete="off"></label>' : '';
  $('e-contenido').innerHTML = (encabezado || '') + buscar + '<ul class="filas" id="e-lista">' + items.map((it) => it.html.replace('<li', '<li data-texto="' + escapar(it.texto.toLowerCase()) + '"')).join('') + '</ul>';
  const f = $('e-filtro');
  if (f) f.addEventListener('input', () => {
    const t = f.value.trim().toLowerCase();
    document.querySelectorAll('#e-lista > li').forEach((li) => { li.hidden = t && li.dataset.texto.indexOf(t) < 0; });
  });
  $('hoja-elegir').classList.add('abierta');
  $('hoja-elegir').scrollTop = 0;
  $('velo').classList.add('visible');
}

// ---------------- Buscar (sitios) ----------------
function pintarBuscar() {
  const t = $('buscar-texto').value.trim().toLowerCase();
  if (!t) { $('buscar-resultados').innerHTML = ''; return; }
  const sin = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const q = sin(t);
  const r = lugares.filter((l) => sin(l.nombre + ' ' + (l.barrio || '')).indexOf(q) >= 0).slice(0, 20);
  $('buscar-resultados').innerHTML = r.length ? r.map((l) => filaSitio(l, escapar(l.barrio || 'Bogotá') + ' · ' + l.votos + (l.votos === 1 ? ' voto' : ' votos'))).join('')
    : '<li class="vacio">No encontramos “' + escapar($('buscar-texto').value.trim()) + '”. Si conoces el sitio, márcalo en el mapa.</li>';
}

// ---------------- Perfil ----------------
function pintarPerfil() {
  const p = yoDatos && yoDatos.perfil;
  const ult = ultimas();
  const nAmigos = yoDatos && yoDatos.amigos ? yoDatos.amigos.length : 0;
  const fotoPerfil = p
    ? '<button type="button" class="avatar-editable" style="padding:0;border:0;background:none" data-accion="editar-avatar" aria-label="Editar tu personaje">' + circulo('avatar grande', p.avatar, p.nombre) + '<span class="lapiz" aria-hidden="true">✎</span></button>'
    : '<span class="avatar grande" aria-hidden="true"><img src="/img/oso-cabeza.webp" alt="" style="width:46px;height:46px;object-fit:contain"></span>';
  let h = '<header class="cabeza"><div class="fila">' + fotoPerfil +
    '<div><h1 style="margin:0;font-size:1.6rem;line-height:1.1">' + escapar(p ? p.nombre : 'Tu diario') + '</h1>' +
    '<p class="sub">' + (p ? '<button type="button" class="enlace" style="padding:0;min-height:0;font:inherit;color:inherit" data-accion="ver-amigos">' + nAmigos + (nAmigos === 1 ? ' amigo' : ' amigos') + '</button> · ' : '') + 'sigues ' + seguidas.size + (seguidas.size === 1 ? ' lista' : ' listas') + '</p>' +
    (p && p.avatar && p.avatar.frase ? '<p class="frase">“' + escapar(p.avatar.frase) + '”</p>' : '') +
    (p && !p.avatar ? '<button type="button" class="enlace" style="padding:0;margin-top:4px" data-accion="editar-avatar">Elige tu personaje</button>' : '') + '</div></div>' +
    (p ? '<button type="button" class="enlace" data-accion="cuenta">Cuenta</button>'
       : '<button type="button" class="secundario" style="min-height:42px;padding:0 14px" data-accion="ir" data-vista="actividad">Entrar</button>') + '</header>';
  h += '<div class="stats"><div><b>' + ult.size + '</b><span>' + (ult.size === 1 ? 'probado' : 'probados') + '</span></div>' +
    '<div><b>' + racha() + '</b><span>' + (racha() === 1 ? 'semana de racha' : 'semanas de racha') + '</span></div>' +
    '<div><b>' + porProbar.size + '</b><span>por probar</span></div></div>';
  if (p) {
    const amigosP = yoDatos.amigos || [];
    const nSol = yoDatos.solicitudes ? yoDatos.solicitudes.recibidas.length : 0;
    h += '<div class="fila entre" style="margin-top:20px"><h2 class="seccion" style="font-size:1.1rem">Mis amigos' + (amigosP.length ? ' · ' + amigosP.length : '') + '</h2>' +
      (amigosP.length ? '<button type="button" class="enlace" style="padding:0" data-accion="ver-amigos">Ver todos</button>' : '') + '</div>' +
      (nSol ? '<button type="button" class="aviso-solicitudes" data-accion="ir" data-vista="actividad">' + nSol + (nSol === 1 ? ' persona quiere' : ' personas quieren') + ' ser tu amigo. Responder →</button>' : '') +
      '<div class="amigos-fila" style="margin-top:8px" aria-label="Tus amigos">' + amigosP.map((a) =>
        '<button type="button" data-accion="abrir-amigo" data-id="' + escapar(a.id) + '">' + circulo('inicial', a.avatar, a.nombre) + escapar(a.nombre.split(' ')[0]) + '</button>').join('') +
      '<button type="button" class="invitar" data-accion="agregar-amigo"><span class="inicial">+</span>Agregar</button></div>' +
      (amigosP.length ? '<p class="sub" style="margin:2px 0 0;font-size:.85rem">Toca a un amigo para ver su perfil, su diario y sus favoritos.</p>' : '');
  }
  h += '<h2 class="seccion" style="margin-top:20px;font-size:1.1rem">Mis favoritos</h2><div class="cuatro">' + cuatro.map((id, i) => {
    const l = id && lugarPorId(id);
    return l ? '<button type="button" data-accion="favorito" data-pos="' + i + '" aria-label="Favorito ' + (i + 1) + ': ' + escapar(l.nombre) + '. Cambiar">' + bun() + '<span>' + escapar(l.nombre) + '</span></button>'
             : '<button type="button" class="libre" data-accion="favorito" data-pos="' + i + '" aria-label="Elegir favorito ' + (i + 1) + '">+</button>';
  }).join('') + '</div>';
  h += '<div class="pastillas pestanas" role="tablist" style="margin-top:20px">' + [['diario', 'Diario'], ['probados', 'Probados'], ['porprobar', 'Por probar'], ['listas', 'Listas']].map(([k, t]) =>
    '<button type="button" class="pastilla' + (subPerfil === k ? ' on' : '') + '" role="tab" aria-selected="' + (subPerfil === k) + '" data-accion="sub-perfil" data-sub="' + k + '">' + t + '</button>').join('') + '</div>';
  h += '<div style="margin-top:12px">';
  if (subPerfil === 'diario') h += htmlDiario();
  else if (subPerfil === 'probados') h += htmlProbados(ult);
  else if (subPerfil === 'porprobar') {
    const ids = Array.from(porProbar.keys()).map(lugarPorId).filter(Boolean);
    h += ids.length ? '<ul class="filas">' + ids.map((l) => '<li class="fila-sitio"><button type="button" class="abrir" data-accion="abrir-lugar" data-id="' + escapar(l.id) + '"><span class="mini">' + bun() + '</span><span><strong>' + escapar(l.nombre) + '</strong><small>' + escapar(l.barrio || 'Bogotá') + ' · ' + escapar(formatoPrecio(l.precio)) + '</small></span></button>' +
      '<button type="button" class="llegar" style="border:0" data-accion="anotar" data-id="' + escapar(l.id) + '">Ya lo probé</button></li>').join('') + '</ul>'
      : oso('nevera', true) + '<p class="vacio" style="text-align:center">Toca el corazón de cualquier sitio para guardarlo aquí y no olvidar ir.</p>';
  } else {
    const ls = listas.filter((li) => seguidas.has(li.id));
    h += ls.length ? '<ul class="filas">' + ls.map((li) => '<li class="tarjeta-lista"><button type="button" class="abrir" data-accion="abrir-lista-inicio" data-id="' + escapar(li.id) + '"><span class="portada" aria-hidden="true">' + escapar(iniciales(li.autor)) + '</span><span><strong>' + escapar(li.titulo) + '</strong><small>' + escapar(li.autor) + '</small></span></button>' + botonSeguir(li) + '</li>').join('') + '</ul>'
      : oso('senala') + '<p class="vacio" style="text-align:center">Todavía no sigues listas. Encuéntralas en Inicio, en la pestaña Listas. Crear tus propias listas llega en enero.</p>';
  }
  h += '</div>';
  if (ult.size) h += resumenAbierto()
    ? '<button type="button" class="boton-resumen" data-accion="resumen">Ver mi resumen buñuelero</button>'
    : '<button type="button" class="boton-resumen" style="background:var(--tostada);color:var(--chocolate)" data-accion="resumen">Tu resumen buñuelero llega el ' + fechaLarga(CONFIG.resumenDesde) + '</button>';
  $('perfil-contenido').innerHTML = h;
}
/** Lo que he probado: una cuadrícula por sitio (como "Films" en Letterboxd), con tu última calificación. */
function htmlProbados(ult) {
  const items = Array.from(ult.values()).filter((e) => lugarPorId(e.idLugar));
  if (!items.length) return oso('piensa') + '<p class="vacio" style="text-align:center">Aquí van a aparecer todos los sitios donde has probado buñuelo, cada uno con tu calificación.</p>';
  const orden = ordenProbados === 'nota' ? items.slice().sort((a, b) => (b.cal || 0) - (a.cal || 0) || (b.fecha > a.fecha ? 1 : -1)) : items;
  return '<div class="fila entre" style="margin-bottom:10px"><p class="sub" style="margin:0">' + items.length + (items.length === 1 ? ' sitio probado' : ' sitios probados') + '</p>' +
    '<div class="orden" role="group" aria-label="Ordenar">' + [['fecha', 'Recientes'], ['nota', 'Mejor calificados']].map(([k, t]) =>
      '<button type="button" data-accion="orden-probados" data-orden="' + k + '" aria-pressed="' + (ordenProbados === k) + '">' + t + '</button>').join('') + '</div></div>' +
    '<div class="probados">' + orden.map((e) => {
      const l = lugarPorId(e.idLugar);
      return '<button type="button" data-accion="abrir-lugar" data-id="' + escapar(l.id) + '" aria-label="' + escapar(l.nombre) + (e.cal ? ', ' + e.cal + ' de 5' : '') + '">' + bun() +
        '<strong>' + escapar(l.nombre) + '</strong>' + (e.cal ? calHtml(e.cal, 11) : '<small>Sin calificar</small>') + (e.volveria === true ? '<small>Volvería</small>' : '') + '</button>';
    }).join('') + '</div>';
}
function htmlDiario(ajenas) {
  const editable = !ajenas;
  const lista = (ajenas || entradasOrdenadas()).filter((e) => lugarPorId(e.idLugar));
  if (!lista.length && ajenas) return '<p class="vacio">Todavía no ha anotado buñuelos.</p>';
  if (!lista.length) return oso('piensa') + '<p class="vacio" style="text-align:center">Tu diario está vacío. Cuando pruebes un buñuelo, búscalo en Inicio o tócalo en el mapa y dale a «Ya lo probé».</p>';
  let mesActual = '', h = '';
  lista.forEach((e) => {
    const [y, m, d] = e.fecha.split('-').map(Number);
    const mes = MESES_LARGOS[m - 1] + ' ' + y;
    if (mes !== mesActual) { if (mesActual) h += '</ul>'; h += '<p class="mono mes">' + mes.toUpperCase() + '</p><ul class="filas">'; mesActual = mes; }
    const l = lugarPorId(e.idLugar);
    h += '<li><button type="button" class="dia" data-accion="' + (editable ? 'editar-entrada' : 'abrir-lugar') + '" data-id="' + escapar(editable ? e.id : e.idLugar) + '" aria-label="' + escapar(l.nombre) + ', ' + d + ' de ' + MESES_LARGOS[m - 1] + (editable ? '. Editar' : '') + '">' +
      '<span class="fecha"><b>' + String(d).padStart(2, '0') + '</b><span class="mono">' + MESES[m - 1] + '</span></span>' +
      '<span style="min-width:0"><strong>' + escapar(l.nombre) + '</strong><small>' + (e.resena ? '“' + escapar(e.resena) + '”' : (e.volveria === true ? 'Volvería' : (e.volveria === false ? 'No volvería' : escapar(l.barrio || '')))) +
      (e.provocas ? ' · ' + e.provocas + ' me provoca' : '') + '</small></span>' + calHtml(e.cal, 16) + '</button></li>';
  });
  return h + '</ul>';
}
function guardarCuatroServidor() {
  if (tokenSesion) pedir('/api/cuatro', { cuatro }).catch(() => {});
}
function elegirFavorito(pos) {
  const ids = Array.from(ultimas().keys()).map(lugarPorId).filter(Boolean);
  const quitar = cuatro[pos] ? '<button type="button" class="secundario" style="width:100%;margin-bottom:12px" data-accion="quitar-favorito" data-pos="' + pos + '">Dejar este espacio libre</button>' : '';
  if (!ids.length) {
    abrirElegir('Mis favoritos', [], null, '<p class="vacio">Tus favoritos salen de lo que has anotado. Anota tu primer buñuelo y vuelve.</p>');
    return;
  }
  abrirElegir('Favorito ' + (pos + 1) + ' de 4', ids.map((l) => ({ id: l.id, texto: l.nombre, html: filaSitioElegir(l) })), (id) => {
    const antes = cuatro.indexOf(id);
    if (antes >= 0) cuatro[antes] = cuatro[pos];
    cuatro[pos] = id;
    guardarLocal(CLAVE_CUATRO, cuatro);
    guardarCuatroServidor();
    pintarPerfil();
  }, quitar);
}
function abrirCuenta() {
  const p = yoDatos && yoDatos.perfil;
  if (!p) return;
  const c = yoDatos.cuenta;
  abrirElegir('Tu cuenta', [], null,
    (c ? '<p class="sub" style="margin:-4px 0 14px">Usuario: @' + escapar(c.usuario) + '</p>' : '') +
    '<form id="c-form" novalidate><label class="campo">Cómo te ven tus amigos<input id="c-nombre" type="text" maxlength="30" value="' + escapar(p.nombre) + '"></label>' +
    (c ? '<label class="campo">Correo <span class="opcional">(opcional)</span><input id="c-correo" type="email" maxlength="254" autocomplete="email" value="' + escapar(c.correo) + '"></label>' +
         '<label class="casilla"><input id="c-avisar" type="checkbox"' + (c.avisar ? ' checked' : '') + '> Avísame por correo cuando esté listo mi resumen</label>' : '') +
    '<p id="c-error" class="error-campo" hidden></p><button class="principal" type="submit">Guardar</button></form>' +
    '<div style="text-align:center;margin-top:14px"><button type="button" class="enlace peligro" data-accion="salir">Salir de mi cuenta</button></div>');
  $('c-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = $('c-nombre').value.trim();
    const error = (t) => { $('c-error').textContent = t; $('c-error').hidden = false; };
    if (nombre.length < 2) { error('Escribe al menos 2 letras.'); return; }
    const r = c
      ? await pedir('/api/cuenta', { nombre, correo: $('c-correo').value.trim(), avisar: $('c-avisar').checked }).catch(() => null)
      : await pedir('/api/perfil', { nombre, idDispositivo }).catch(() => null);
    if (!r || !r.ok) { error((r && r.mensaje) || 'No pudimos guardar.'); return; }
    cerrarElegir(); avisar('Listo, guardamos los cambios.'); await cargarYo();
  });
}

// ---------------- Cuenta y amigos ----------------
const CLAVE_INVITACION = 'mejorbunuelo.invitacionPendiente';
let ordenProbados = 'fecha';
let yoDatos = null, nombreInvitador = '';
const CLAVE_SESION = 'buenamuela.sesion';
let resumenPendiente = false;           // llegó del correo del resumen y tiene que entrar primero
let modoCuenta = 'crear';               // 'crear' | 'entrar'
tokenSesion = leerLocal(CLAVE_SESION, '') || '';
let eventos = null;

(function guardarInvitacionDeLaUrl() {
  const params = new URLSearchParams(location.search);
  const codigo = (params.get('amigo') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!codigo) return;
  guardarLocal(CLAVE_INVITACION, codigo);
  params.delete('amigo');
  const q = params.toString();
  history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
})();
async function iniciarAmigos() {
  const pendiente = leerLocal(CLAVE_INVITACION, null);
  if (pendiente) pedir('/api/invitacion', { codigo: pendiente }).then((r) => { if (r && r.ok) { nombreInvitador = r.nombre; if (vista === 'actividad') pintarActividad(); } }).catch(() => {});
  await cargarYo();
  if (tokenSesion) cargarDiario();
  if (leerLocal(CLAVE_INVITACION, null) && !(yoDatos && yoDatos.perfil)) irA('actividad');
}
async function cargarYo() {
  try {
    const r = await pedir('/api/yo');
    if (r && r.ok) {
      yoDatos = r;
      // la sesión propia venció o la cerraron en otro lado
      if (!r.conectado && tokenSesion.startsWith('bm_')) { tokenSesion = ''; guardarLocal(CLAVE_SESION, null); }
      if (r.perfil && r.cuenta && !r.cuenta.aceptoDatos) pedirAutorizacionDatos();
      else if (r.perfil) confirmarInvitacionPendiente();
    }
  } catch {}
  if (yoDatos && yoDatos.perfil) cargarActividad(true);
  marcarSolicitudes();
  repintar();
}
/** Cuentas creadas antes de la casilla de datos: se pide la autorización una sola vez. */
function pedirAutorizacionDatos() {
  abrirElegir('Antes de seguir', [], null,
    '<p style="font-size:1.02rem;line-height:1.45;margin:0 0 14px">Apetitosos es un proyecto de El Espectador. Para seguir usando tu cuenta necesitamos que autorices el tratamiento de tus datos (tu nombre, tu usuario y, si lo diste, tu correo) según la ' +
    '<a href="' + escapar(urlPolitica()) + '" target="_blank" rel="noopener">política de tratamiento de datos</a>.</p>' +
    '<button type="button" class="principal" data-accion="aceptar-datos">Autorizo</button>' +
    '<div style="text-align:center;margin-top:10px"><button type="button" class="enlace" data-accion="salir">Prefiero salir de mi cuenta</button></div>');
}
async function aceptarDatos(b) {
  b.disabled = true;
  const r = await pedir('/api/aceptar-datos', {}).catch(() => null);
  if (!r || !r.ok) { b.disabled = false; avisar((r && r.mensaje) || 'No pudimos guardar tu respuesta. Intenta otra vez.', 'error'); return; }
  if (yoDatos.cuenta) yoDatos.cuenta.aceptoDatos = true;
  cerrarElegir(); avisar('Gracias. Ya puedes seguir.');
  confirmarInvitacionPendiente();
}
/** Una invitación nunca se acepta sola: se muestra quién invita y se pide Aceptar o Ahora no. */
async function confirmarInvitacionPendiente() {
  const codigo = leerLocal(CLAVE_INVITACION, null);
  if (!codigo) return;
  const r = await pedir('/api/invitacion', { codigo }).catch(() => null);
  if (!r || !r.ok) {
    guardarLocal(CLAVE_INVITACION, null); nombreInvitador = '';
    if (r && r.mensaje) avisar(r.mensaje, 'error');
    return;
  }
  abrirElegir('Invitación de ' + r.nombre, [], null,
    '<p style="font-size:1.05rem;line-height:1.45;margin:0 0 16px"><strong>' + escapar(r.nombre) + '</strong> te invitó a ser su amigo en Apetitosos. Si aceptas, cada uno va a poder ver el diario, el Por probar y los favoritos del otro.</p>' +
    '<button type="button" class="principal" data-accion="invitacion-si">Aceptar</button>' +
    '<div style="text-align:center;margin-top:10px"><button type="button" class="enlace" data-accion="invitacion-no">Ahora no</button></div>');
}
async function aceptarInvitacionPendiente() {
  const codigo = leerLocal(CLAVE_INVITACION, null);
  if (!codigo) return;
  const r = await pedir('/api/amigos', { codigo }).catch(() => null);
  if (!r) return;
  guardarLocal(CLAVE_INVITACION, null);
  nombreInvitador = '';
  if (r.ok) {
    avisar(r.nuevo ? 'Listo: ahora tú y ' + r.amigo.nombre + ' son amigos buñueleros.' : 'Tú y ' + r.amigo.nombre + ' ya eran amigos.');
    const f = await pedir('/api/yo').catch(() => null);
    if (f && f.ok) yoDatos = f;
    cargarActividad(true); repintar();
  } else if (!r.propia) avisar(r.mensaje || 'No pudimos aceptar la invitación.', 'error');
}
async function cargarActividad(enSilencio) {
  if (!yoDatos || !yoDatos.perfil) return;
  try {
    const r = await pedir('/api/actividad');
    if (!r.ok) return;
    eventos = r.eventos || [];
    const vista0 = leerLocal(CLAVE_ACTIVIDAD_VISTA, 0);
    $('punto-actividad').hidden = vista === 'actividad' || (!eventos.some((e) => !e.propio && e.creado > vista0) && !(yoDatos.solicitudes && yoDatos.solicitudes.recibidas.length));
    if (vista === 'actividad') pintarActividad();
  } catch {}
}
function enlaceInvitacion() { return location.origin + location.pathname + '?amigo=' + yoDatos.perfil.codigo; }
function oso(pose, ancha) { return '<div class="mascota-caja' + (ancha ? ' ancha' : '') + '"><img src="/img/oso-' + pose + '.webp" alt="" loading="lazy"></div>'; }

// ---------------- Oso guardián ----------------
// Mira lo que escribes en el nombre, el usuario y el correo, se tapa los ojos en la contraseña,
// espía entre los dedos si tocas "Mostrar" y niega cuando hay un error. Son 9 retratos con el mismo encuadre.
const POSES_OSO = ['reposo', 'izq2', 'izq1', 'centro', 'der1', 'der2', 'tapado', 'espia', 'uy'];
const OSO_GUARDIAN = '<span class="oso-guardian" id="oso-guardian"><img src="/img/og-reposo.webp" alt="El oso de Apetitosos" width="150" height="150"></span>';
let medidor = null, osoPrecargado = false, osoUy = 0;
function poseOso(pose) {
  const img = document.querySelector('#oso-guardian img');
  if (img && !img.src.endsWith('/og-' + pose + '.webp')) img.src = '/img/og-' + pose + '.webp';
}
function animarOso(form) {
  if (!$('oso-guardian')) return;
  if (!osoPrecargado) { osoPrecargado = true; POSES_OSO.forEach((k) => { new Image().src = '/img/og-' + k + '.webp'; }); }
  const clave = $('f-clave'), ojo = $('f-ver-clave');
  function lectura(input) {
    if (!medidor) medidor = document.createElement('canvas').getContext('2d');
    const st = getComputedStyle(input);
    medidor.font = st.fontWeight + ' ' + st.fontSize + ' ' + st.fontFamily;
    const hasta = input.selectionStart == null ? input.value.length : input.selectionStart;
    const ancho = medidor.measureText(input.value.slice(0, hasta)).width + parseFloat(st.paddingLeft);
    const r = Math.max(0, Math.min(0.999, ancho / Math.max(input.clientWidth * 0.7, 1)));   // casi nadie llena el campo entero
    return ['izq2', 'izq1', 'centro', 'der1', 'der2'][Math.floor(r * 5)];
  }
  function estado() {
    if (Date.now() < osoUy) return;
    const a = document.activeElement;
    if (a === clave || a === ojo) poseOso(clave.type === 'text' ? 'espia' : 'tapado');
    else if (a && form.contains(a) && a.tagName === 'INPUT' && a.type !== 'checkbox') poseOso(lectura(a));
    else poseOso('reposo');
  }
  form.addEventListener('focusin', estado);
  form.addEventListener('focusout', () => setTimeout(estado, 0));
  form.addEventListener('input', estado);
  form.addEventListener('keyup', estado);
  form.addEventListener('click', estado);
  form._estadoOso = estado;
  ojo.addEventListener('click', () => {
    const ver = clave.type === 'password';
    clave.type = ver ? 'text' : 'password';
    ojo.textContent = ver ? 'Ocultar' : 'Mostrar';
    ojo.setAttribute('aria-pressed', String(ver));
    clave.focus();
    estado();
  });
}
function osoNiega() {
  const oso = $('oso-guardian');
  if (!oso) return;
  osoUy = Date.now() + 1600;
  poseOso('uy');
  oso.classList.remove('uy'); void oso.offsetWidth; oso.classList.add('uy');
  setTimeout(() => { osoUy = 0; const f = $('cuenta-form'); if (f && f._estadoOso) f._estadoOso(); }, 1650);
}
function pintarActividad() {
  const caja = $('actividad-contenido');
  $('buscar-amigo').hidden = true;
  const invit = nombreInvitador ? '<div class="tarjeta" style="margin-bottom:14px"><strong>' + escapar(nombreInvitador) + ' te invitó.</strong><p class="sub">Entra para que cada uno vea qué buñuelos probó el otro.</p></div>' : '';
  if (!yoDatos || !yoDatos.conectado) {
    const crear = modoCuenta === 'crear';
    caja.innerHTML = invit + (resumenPendiente ? '<div class="tarjeta" style="margin-bottom:14px"><strong>Tu resumen te espera.</strong><p class="sub">Entra a tu cuenta para verlo.</p></div>' : '') +
      OSO_GUARDIAN + '<p style="text-align:center;font-size:1.1rem;line-height:1.4;margin:6px 0 16px">Crea tu cuenta para ver qué buñuelos están probando tus amigos, qué nota les ponen y qué tienen en Por probar.</p>' +
      '<div class="segmento"><button type="button" data-accion="modo-cuenta" data-modo="crear" aria-pressed="' + crear + '">Crear cuenta</button>' +
      '<button type="button" data-accion="modo-cuenta" data-modo="entrar" aria-pressed="' + !crear + '">Ya tengo cuenta</button></div>' +
      '<form id="cuenta-form" novalidate>' +
      (crear ? '<label class="campo">Cómo te van a ver tus amigos<input id="f-nombre" type="text" maxlength="30" autocomplete="nickname" placeholder="Ej: Camilo"></label>' : '') +
      '<label class="campo">Usuario<input id="f-usuario" type="text" maxlength="20" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Ej: camilo.bunuelero"></label>' +
      '<label class="campo">Contraseña' + (crear ? ' <span class="opcional">(mínimo 8 caracteres)</span>' : '') + '<span class="con-ojo"><input id="f-clave" type="password" maxlength="200" autocomplete="' + (crear ? 'new-password' : 'current-password') + '">' +
        '<button type="button" id="f-ver-clave" aria-pressed="false" aria-label="Mostrar u ocultar la contraseña">Mostrar</button></span></label>' +
      (crear ? '<label class="campo">Correo <span class="opcional">(opcional)</span><input id="f-correo" type="email" maxlength="254" autocomplete="email" placeholder="Ej: tu@correo.com"></label>' +
               '<label class="casilla"><input id="f-avisar" type="checkbox" checked> Avísame por correo cuando esté listo mi resumen</label>' +
               '<label class="casilla"><input id="f-acepta" type="checkbox"> <span>Autorizo a El Espectador a tratar mis datos según su <a href="' + escapar(urlPolitica()) + '" target="_blank" rel="noopener">política de tratamiento de datos</a>.</span></label>' : '') +
      '<p id="f-error" class="error-campo" hidden></p>' +
      '<button class="principal" type="submit">' + (crear ? 'Crear mi cuenta' : 'Entrar') + '</button></form>' +
      '<p class="sub" style="text-align:center;margin-top:12px">' + (crear
        ? 'Con tu cuenta votas, anotas y guardas tu diario en todos tus dispositivos. Tus amigos solo ven tu nombre, tu @usuario y lo que anotas. Tu correo no se le muestra a nadie. Guarda bien tu contraseña: por ahora no hay forma de recuperarla.'
        : 'Lo que anotaste en este teléfono se suma a tu cuenta.') + '</p>';
    $('cuenta-form').addEventListener('submit', enviarCuenta);
    animarOso($('cuenta-form'));
    return;
  }
  if (!yoDatos.perfil) {
    caja.innerHTML = invit + '<form id="p-form" novalidate><p style="font-size:1.1rem;margin:0 0 12px">¿Cómo quieres que te vean tus amigos?</p>' +
      '<label class="campo">Tu nombre o apodo<input id="p-nombre" type="text" maxlength="30" autocomplete="nickname" placeholder="Ej: Camilo"></label>' +
      '<p id="p-error" class="error-campo" hidden></p><button class="principal" type="submit">Listo</button></form>' +
      '<div style="text-align:center;margin-top:10px"><button type="button" class="enlace" data-accion="salir">Salir</button></div>';
    $('p-form').addEventListener('submit', guardarNombre);
    return;
  }
  $('buscar-amigo').hidden = false;
  const amigos = yoDatos.amigos || [];
  const recibidas = (yoDatos.solicitudes && yoDatos.solicitudes.recibidas) || [];
  let h = recibidas.length ? '<h2 class="seccion" style="font-size:1.05rem;margin-bottom:8px">' + (recibidas.length === 1 ? 'Te quiere agregar' : 'Te quieren agregar') + '</h2><ul class="filas" style="margin-bottom:16px">' +
    recibidas.map((x) => filaPersona(x, '<button type="button" class="llegar con-color" data-accion="responder-solicitud" data-id="' + escapar(x.id) + '" data-si="1">Aceptar</button>' +
      '<button type="button" class="llegar" data-accion="responder-solicitud" data-id="' + escapar(x.id) + '" data-si="0" aria-label="Rechazar a ' + escapar(x.nombre) + '">✕</button>')).join('') + '</ul>' : '';
  h += '<div class="amigos-fila" aria-label="Tus amigos">' + amigos.map((a) =>
    '<button type="button" data-accion="abrir-amigo" data-id="' + escapar(a.id) + '">' + circulo('inicial', a.avatar, a.nombre) + escapar(a.nombre.split(' ')[0]) + '</button>').join('') +
    '<button type="button" class="invitar" data-accion="invitar"><span class="inicial">+</span>Invitar</button></div>';
  h += '<div class="pastillas" role="tablist" style="margin-top:16px">' + [['amigos', 'Amigos'], ['tu', 'Tú']].map(([k, t]) =>
    '<button type="button" class="pastilla' + (subActividad === k ? ' on' : '') + '" role="tab" aria-selected="' + (subActividad === k) + '" data-accion="sub-actividad" data-sub="' + k + '">' + t + '</button>').join('') + '</div>';
  const lista = (eventos || []).filter((e) => (subActividad === 'tu') === !!e.propio).filter((e) => lugarPorId(e.idLugar));
  if (eventos === null) h += '<p class="vacio" style="margin-top:14px">Cargando…</p>';
  else if (!lista.length) h += '<div style="margin-top:14px">' + oso('duerme') + '</div><p class="vacio" style="text-align:center">' + (subActividad === 'tu' ? 'Todavía no has anotado nada.' : (amigos.length ? 'Tus amigos no han anotado nada en los últimos 60 días.' : 'Busca a tus amigos por su @usuario arriba, o invítalos con el botón +.')) + '</p>';
  else h += '<ul class="filas" style="margin-top:14px">' + lista.map(htmlEvento).join('') + '</ul>';
  caja.innerHTML = h;
}
/** Fila de una persona: su círculo, nombre, @usuario y botones a la derecha. */
function filaPersona(x, botones) {
  return '<li class="fila-sitio"><button type="button" class="abrir"' + (x.estado === 'amigo' || x.amigo ? ' data-accion="abrir-amigo" data-id="' + escapar(x.id) + '"' : ' tabindex="-1"') + '>' + circulo('inicial', x.avatar, x.nombre) +
    '<span><strong>' + escapar(x.nombre) + '</strong><small>' + (x.usuario ? '@' + escapar(x.usuario) : '') + '</small></span></button>' + botones + '</li>';
}
let baTiempo = 0, baUltima = '';
function buscarAmigoEscrito() {
  clearTimeout(baTiempo);
  const q = $('ba-texto').value.trim().replace(/^@/, '').toLowerCase();
  if (q.length < 3) { baUltima = ''; $('ba-resultados').innerHTML = q ? '<li class="vacio">Escribe al menos 3 letras de su usuario.</li>' : ''; return; }
  baTiempo = setTimeout(async () => {
    baUltima = q;
    const r = await pedir('/api/buscar-amigo?u=' + encodeURIComponent(q)).catch(() => null);
    if (q !== baUltima) return;
    pintarResultadosAmigo(r);
  }, 250);
}
function pintarResultadosAmigo(r) {
  if (!r || !r.ok) { $('ba-resultados').innerHTML = '<li class="vacio">' + escapar((r && r.mensaje) || 'No pudimos buscar. Revisa tu conexión.') + '</li>'; return; }
  if (!r.resultados.length) { $('ba-resultados').innerHTML = '<li class="vacio">Nadie tiene un usuario que empiece por “@' + escapar(baUltima) + '”. Si no tiene cuenta, invítalo con el botón +.</li>'; return; }
  $('ba-resultados').innerHTML = r.resultados.map((x) => {
    const b = x.estado === 'tu' ? '<span class="llegar">Eres tú</span>'
      : x.estado === 'amigo' ? '<span class="llegar">Amigos ✓</span>'
      : x.estado === 'enviada' ? '<span class="llegar">Solicitud enviada</span>'
      : x.estado === 'recibida' ? '<button type="button" class="llegar con-color" data-accion="responder-solicitud" data-id="' + escapar(x.id) + '" data-si="1">Aceptar</button>'
      : '<button type="button" class="llegar con-color" data-accion="solicitar" data-id="' + escapar(x.id) + '">Agregar</button>';
    return filaPersona(x, b);
  }).join('');
}
async function refrescarYo() {
  const f = await pedir('/api/yo').catch(() => null);
  if (f && f.ok) yoDatos = f;
  marcarSolicitudes();
}
function marcarSolicitudes() {
  const n = yoDatos && yoDatos.solicitudes ? yoDatos.solicitudes.recibidas.length : 0;
  if (n && vista !== 'actividad') $('punto-actividad').hidden = false;
}
async function solicitar(id, boton) {
  if (boton) boton.disabled = true;
  const r = await pedir('/api/solicitud', { id }).catch(() => null);
  if (!r || !r.ok) { if (boton) boton.disabled = false; avisar((r && r.mensaje) || 'No pudimos mandar la solicitud.', 'error'); return; }
  if (r.estado === 'amigo') { avisar('Listo, ya son amigos.'); await refrescarYo(); cargarActividad(); repintar(); }
  else avisar('Solicitud enviada. Cuando la acepte, van a poder ver sus diarios.');
  const q = baUltima;
  if (q) pintarResultadosAmigo(await pedir('/api/buscar-amigo?u=' + encodeURIComponent(q)).catch(() => null));
}
async function responderSolicitud(id, aceptar) {
  const r = await pedir('/api/solicitud/responder', { id, aceptar }).catch(() => null);
  if (!r || !r.ok) { avisar((r && r.mensaje) || 'No pudimos responder.', 'error'); await refrescarYo(); repintar(); return; }
  const x = yoDatos.solicitudes.recibidas.find((s) => s.id === id);
  avisar(aceptar ? 'Listo: ahora tú y ' + (x ? x.nombre : 'tu amigo') + ' son amigos.' : 'Solicitud rechazada. No le avisamos.');
  await refrescarYo(); if (aceptar) cargarActividad(); repintar();
  if (baUltima) pintarResultadosAmigo(await pedir('/api/buscar-amigo?u=' + encodeURIComponent(baUltima)).catch(() => null));
}
function htmlEvento(e) {
  const l = lugarPorId(e.idLugar);
  const quien = e.propio ? 'Tú' : '<button type="button" class="sitio" data-accion="abrir-amigo" data-id="' + escapar(e.idPerfil) + '">' + escapar(e.nombre) + '</button>';
  const sitio = '<button type="button" class="sitio" data-accion="abrir-lugar" data-id="' + escapar(l.id) + '">' + escapar(l.nombre) + '</button>';
  if (e.tipo === 'por_probar') {
    return '<li class="evento">' + circulo('inicial', e.avatar, e.nombre) + '<div><p><strong>' + quien + '</strong> agregó ' + sitio + ' a Por probar</p>' +
      '<div class="pie"><small>' + haceCuanto(e.creado) + '</small>' + corazonTexto(l.id) + '</div></div></li>';
  }
  const prov = e.propio
    ? (e.provocas ? '<small>' + e.provocas + ' me provoca</small>' : '')
    : '<button type="button" class="provoca" data-accion="provocar" data-id="' + escapar(e.id) + '" aria-pressed="' + !!e.mio + '"><svg aria-hidden="true"><use href="#i-corazon"/></svg>Me provoca' + (e.provocas ? ' · ' + e.provocas : '') + '</button>';
  return '<li class="evento">' + (e.propio ? circulo('inicial tu', yoDatos.perfil.avatar, yoDatos.perfil.nombre || 'T') : circulo('inicial', e.avatar, e.nombre)) + '<div>' +
    '<p><strong>' + quien + '</strong> ' + (e.propio ? 'anotaste' : 'anotó') + ' ' + sitio + '</p><div style="margin-top:6px">' + calHtml(e.cal, 20) + '</div>' +
    (e.resena ? '<p class="resena">“' + escapar(e.resena) + '”</p>' : '') +
    '<div class="pie"><small>' + escapar(fechaCorta(e.fecha)) + (e.volveria === true ? ' · volvería' : (e.volveria === false ? ' · no volvería' : '')) + '</small>' + prov + '</div></div></li>';
}
function corazonTexto(id) {
  const on = porProbar.has(id);
  return '<button type="button" class="provoca" data-accion="por-probar" data-id="' + escapar(id) + '" aria-pressed="' + on + '"><svg aria-hidden="true"><use href="#i-corazon"/></svg>' + (on ? 'En tu lista' : 'Yo también') + '</button>';
}
async function provocar(idEntrada) {
  const e = (eventos || []).find((x) => x.id === idEntrada);
  if (!e) return;
  const quitar = !!e.mio;
  e.mio = !quitar; e.provocas = Math.max(0, (e.provocas || 0) + (quitar ? -1 : 1));
  pintarActividad();
  const r = await pedir('/api/provocar', { idEntrada, quitar }).catch(() => null);
  if (!r || !r.ok) { e.mio = quitar; e.provocas = Math.max(0, e.provocas + (quitar ? 1 : -1)); pintarActividad(); avisar((r && r.mensaje) || 'No pudimos guardarlo.', 'error'); }
  else { e.provocas = r.provocas; pintarActividad(); }
}
async function abrirAmigo(id) {
  const a = ((yoDatos && yoDatos.amigos) || []).find((x) => x.id === id);
  const nombre = a ? a.nombre : 'Tu amigo';
  abrirElegir(nombre, [], null, '<p class="vacio">Cargando su perfil…</p>');
  const r = await pedir('/api/perfil-amigo?id=' + encodeURIComponent(id)).catch(() => null);
  if (!r || !r.ok) { $('e-contenido').innerHTML = '<p class="vacio">' + escapar((r && r.mensaje) || 'No pudimos cargar su perfil. Revisa tu conexión.') + '</p>'; return; }
  const p = r.perfil;
  const lugaresProbados = new Set(r.entradas.map((e) => e.idLugar));
  const rch = racha(r.entradas);
  const c4 = Array.isArray(p.cuatro) ? p.cuatro : [null, null, null, null];
  let h = '<div class="fila" style="margin:-2px 0 4px">' + circulo('avatar grande', p.avatar, p.nombre) +
    '<div>' + (p.usuario ? '<p style="margin:0;font-weight:700">@' + escapar(p.usuario) + '</p>' : '') + '<p class="sub" style="margin:0">' + p.amigos + (p.amigos === 1 ? ' amigo' : ' amigos') + ' en Apetitosos</p>' +
    (p.avatar && p.avatar.frase ? '<p class="frase">“' + escapar(p.avatar.frase) + '”</p>' : '') + '</div></div>';
  h += '<div class="stats"><div><b>' + lugaresProbados.size + '</b><span>' + (lugaresProbados.size === 1 ? 'probado' : 'probados') + '</span></div>' +
    '<div><b>' + rch + '</b><span>' + (rch === 1 ? 'semana de racha' : 'semanas de racha') + '</span></div>' +
    '<div><b>' + r.porProbar.length + '</b><span>por probar</span></div></div>';
  if (c4.some((x) => x && lugarPorId(x))) {
    h += '<h3 style="margin:18px 0 0;font-size:1.05rem">Sus favoritos</h3><div class="cuatro">' + c4.map((lid) => {
      const l = lid && lugarPorId(lid);
      return l ? '<button type="button" data-accion="abrir-lugar" data-id="' + escapar(l.id) + '">' + bun() + '<span>' + escapar(l.nombre) + '</span></button>'
               : '<button type="button" class="libre" disabled aria-label="Espacio libre"></button>';
    }).join('') + '</div>';
  }
  h += '<h3 style="margin:18px 0 0;font-size:1.05rem">Su diario</h3>' + htmlDiario(r.entradas);
  const pp = r.porProbar.map((x) => lugarPorId(x.idLugar)).filter(Boolean);
  if (pp.length) h += '<h3 style="margin:18px 0 8px;font-size:1.05rem">Quiere probar</h3><ul class="filas">' +
    pp.map((l) => filaSitio(l, escapar(l.barrio || 'Bogotá') + ' · ' + escapar(formatoPrecio(l.precio)))).join('') + '</ul>';
  h += '<div style="text-align:center;margin-top:18px"><button type="button" class="enlace peligro" data-accion="quitar-amigo" data-id="' + escapar(p.id) + '">Dejar de ser amigos</button></div>';
  $('e-titulo').textContent = p.nombre;
  $('e-contenido').innerHTML = h;
}
function invitar() {
  abrirElegir('Invita a un amigo', [], null,
    '<p class="sub" style="margin:0 0 8px">Mándale este enlace. Cuando entre, quedan conectados los dos.</p><code class="enlace-invitacion">' + escapar(enlaceInvitacion()) + '</code>' +
    '<button type="button" class="principal" data-accion="compartir-invitacion">Compartir invitación</button>');
}

async function guardarNombre(e) {
  e.preventDefault();
  const nombre = $('p-nombre').value.trim(), err = $('p-error');
  err.hidden = true;
  if (nombre.length < 2) { err.textContent = 'Escribe al menos 2 letras.'; err.hidden = false; return; }
  const b = $('p-form').querySelector('button[type=submit]'); b.disabled = true;
  try {
    const r = await pedir('/api/perfil', { nombre, idDispositivo });
    if (!r.ok) { err.textContent = r.mensaje; err.hidden = false; b.disabled = false; return; }
    await cargarYo(); cargarDiario();
  } catch (err) { err.textContent = 'No pudimos guardar. Revisa tu conexión.'; err.hidden = false; b.disabled = false; }
}
async function compartirInvitacion() {
  const url = enlaceInvitacion();
  const texto = yoDatos.perfil.nombre + ' te invita a Apetitosos para ver qué buñuelos ha probado.';
  if (navigator.share) { try { await navigator.share({ title: 'Apetitosos', text: texto, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); avisar('Enlace copiado. Pégalo en WhatsApp.'); } catch { avisar('Copia el enlace que aparece en el recuadro.'); }
}
async function quitarAmigo(id, boton) {
  if (boton.dataset.confirmar !== '1') { boton.dataset.confirmar = '1'; boton.textContent = '¿Seguro? Toca otra vez'; return; }
  const r = await pedir('/api/amigos/quitar', { idAmigo: id }).catch(() => null);
  if (!r || !r.ok) { avisar('No pudimos quitarlo. Intenta de nuevo.', 'error'); return; }
  cerrarElegir(); avisar('Ya no son amigos en la app.'); await cargarYo();
}
async function enviarCuenta(e) {
  e.preventDefault();
  const crear = modoCuenta === 'crear';
  const err = $('f-error');
  const error = (t) => { err.textContent = t; err.hidden = false; osoNiega(); };
  err.hidden = true;
  const datos = { usuario: $('f-usuario').value.trim(), clave: $('f-clave').value, idDispositivo };
  if (crear) {
    datos.nombre = $('f-nombre').value.trim();
    datos.correo = $('f-correo').value.trim();
    datos.avisar = $('f-avisar').checked;
    if (datos.nombre.length < 2) { error('Escribe cómo quieres que te vean tus amigos (mínimo 2 letras).'); return; }
    if (datos.clave.length < 8) { error('La contraseña debe tener al menos 8 caracteres.'); return; }
    datos.acepta = $('f-acepta').checked;
    if (!datos.acepta) { error('Para crear tu cuenta tienes que aceptar la política de tratamiento de datos.'); return; }
  }
  if (!datos.usuario || !datos.clave) { error('Escribe tu usuario y tu contraseña.'); return; }
  const b = $('cuenta-form').querySelector('button[type=submit]');
  b.disabled = true; b.textContent = crear ? 'Creando tu cuenta…' : 'Entrando…';
  try {
    datos.token = await tokenCaptcha();
    const r = await pedir(crear ? '/api/registro' : '/api/entrar', datos);
    if (!r.ok) { error(r.mensaje || 'No pudimos entrar.'); b.disabled = false; b.textContent = crear ? 'Crear mi cuenta' : 'Entrar'; return; }
    tokenSesion = r.token;
    guardarLocal(CLAVE_SESION, r.token);
    // Este navegador ya estaba unido a otra cuenta: estrena un id propio (nunca se le quita a la otra)
    if (r.dispositivoAjeno) { idDispositivo = nuevoId(); guardarLocal(CLAVE_DISPOSITIVO, idDispositivo); }
    avisar(crear ? '¡Bienvenido, ' + r.perfil.nombre + '! Ya tienes cuenta.' : 'Hola de nuevo, ' + r.perfil.nombre + '.');
    await cargarYo();
    await cargarDiario();
    if (resumenPendiente) { resumenPendiente = false; irA('perfil'); setTimeout(abrirWrapped, 300); }
  } catch { error('No pudimos conectarnos. Revisa tu conexión e intenta de nuevo.'); b.disabled = false; b.textContent = crear ? 'Crear mi cuenta' : 'Entrar'; }
}

async function salir() {
  if (tokenSesion) pedir('/api/salir', {}).catch(() => {});
  guardarLocal(CLAVE_SESION, null);
  tokenSesion = ''; eventos = null;
  yoDatos = { ok: true, activo: true, conectado: false };
  // Nada de la cuenta queda a la vista en este navegador (por si es compartido)
  [CLAVE_DIARIO, CLAVE_CUATRO, CLAVE_VOTADOS, CLAVE_ACTIVIDAD_VISTA, CLAVE_INVITACION].forEach((k) => guardarLocal(k, null));
  entradas = []; porProbar = new Map(); seguidas = new Set(); votados.clear(); cuatro = [null, null, null, null];
  cerrarElegir(); repintar();
  avisar('Saliste de tu cuenta. Tu diario sigue guardado en ella.');
}

// ---------------- Resumen buñuelero (tipo Wrapped) ----------------
const DURACION_ESCENA = 6500;
const SIN_MOVIMIENTO = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const COLORES = { rojo: ['#C8322B', '#FFFDF8'], dorado: ['#F2C230', '#3B2A1E'], musgo: ['#5E7A4A', '#FFFDF8'], chocolate: ['#3B2A1E', '#FFFDF8'], masa: ['#F1E2C8', '#312A20'] };
let escenas = [], escenaActual = 0;
function fmtKm(km) { return km.toLocaleString('es-CO', { maximumFractionDigits: 1 }); }
function fmtPesos(n) { return '$' + Math.round(n).toLocaleString('es-CO'); }
function datosResumen() {
  const primeras = new Map();
  entradas.slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).forEach((e) => { if (!primeras.has(e.idLugar)) primeras.set(e.idLugar, e.fecha); });
  const ult = ultimas();
  const lista = Array.from(primeras.keys()).map((id) => {
    const l = lugarPorId(id);
    return l ? Object.assign({}, l, { primera: primeras.get(id), cal: ult.get(id).cal }) : null;
  }).filter(Boolean).sort((a, b) => a.primera.localeCompare(b.primera));
  const n = lista.length;
  const barrios = Array.from(new Set(lista.map((l) => (l.barrio || '').trim()).filter(Boolean)));
  let km = 0;
  for (let i = 1; i < n; i++) km += distanciaMetros(lista[i - 1].lat, lista[i - 1].lng, lista[i].lat, lista[i].lng) / 1000;
  const conPrecio = lista.filter(tienePrecio);
  const gasto = conPrecio.reduce((s, l) => s + l.precio, 0);
  const promedio = conPrecio.length ? gasto / conPrecio.length : null;
  const barato = conPrecio.length > 1 ? conPrecio.reduce((a, b) => (b.precio < a.precio ? b : a)) : null;
  const caro = conPrecio.length > 1 ? conPrecio.reduce((a, b) => (b.precio > a.precio ? b : a)) : null;
  const favorito = lista.slice().sort((a, b) => (b.cal - a.cal) || (b.votos - a.votos))[0];
  const top10 = new Set(ordenados().slice(0, 10).map((l) => l.id));
  const enTop = lista.filter((l) => top10.has(l.id)).length;
  const promCal = n ? lista.reduce((s, l) => s + l.cal, 0) / n : null;
  const visitas = entradas.length;
  const d = { lista, n, barrios, km, conPrecio, gasto, promedio, barato, caro, favorito, enTop, promCal, visitas, racha: racha() };
  d.perso = personalidad(d);
  return d;
}
function personalidad(d) {
  if (d.n >= 8) return { titulo: 'Maratón buñuelera', texto: 'Lo tuyo no fue un antojo, fue una temporada completa.' };
  if (d.n >= 3 && d.promCal !== null && d.promCal <= 2.5) return { titulo: 'Paladar exigente', texto: 'Pocos buñuelos te convencen. Cuando uno te gusta, es porque es muy bueno.' };
  if (d.n >= 3 && d.promCal !== null && d.promCal >= 4.5) return { titulo: 'Corazón de buñuelo', texto: 'Casi todos te parecieron de otro mundo. La Navidad te queda fácil.' };
  if (d.visitas >= d.n + 3) return { titulo: 'Fidelidad de esquina', texto: 'Encontraste tu buñuelo y volviste una y otra vez.' };
  if (d.barrios.length >= 4) return { titulo: 'Alma exploradora', texto: 'Cruzaste la ciudad por un buñuelo. Varias veces.' };
  if (d.promedio !== null && d.promedio <= 2000) return { titulo: 'Ojo para las gangas', texto: 'Sabes que el mejor buñuelo no tiene que ser el más caro.' };
  if (d.promedio !== null && d.promedio >= 3200) return { titulo: 'Paladar fino', texto: 'Si es buñuelo, que sea de los buenos. Y que se note.' };
  if (d.n >= 2 && d.enTop === d.n) return { titulo: 'Ojo de jurado', texto: 'Todo lo que probaste está en el Top 10. ¿Seguro que no eres del jurado?' };
  if (d.n >= 2 && d.enTop === 0) return { titulo: 'Olfato de descubrimiento', texto: 'Fuiste a donde casi nadie había votado. Ahí está el próximo Top 10.' };
  return { titulo: 'Buena muela', texto: 'Comes con criterio y con cariño. Así se hace.' };
}
function construirEscenas(d) {
  const e = [];
  const sitios = d.n === 1 ? 'sitio probado' : 'sitios probados';
  let pila = '';
  for (let i = 0; i < Math.min(d.visitas, 24); i++) pila += '<svg viewBox="0 0 100 100" style="animation-delay:' + (0.6 + i * 0.09).toFixed(2) + 's" aria-hidden="true"><use href="#bunuelo"/></svg>';
  e.push({ color: 'rojo', html: '<p class="w-pre">Tu temporada en buñuelos</p><p class="w-grande">' + d.n + '</p><p class="w-medio">' + sitios + ' en Bogotá.</p>' +
    (d.visitas > d.n ? '<p class="w-texto">Y ' + d.visitas + ' anotaciones en total. Hubo repetición.</p>' : '') + '<div class="w-pila">' + pila + '</div>' });
  if (d.barrios.length === 1) e.push({ color: 'dorado', html: '<p class="w-pre">Tu zona</p><p class="w-medio">' + escapar(d.barrios[0]) + '</p><p class="w-texto">Todos tus buñuelos fueron por el mismo lado. Fidelidad absoluta al barrio.</p>' });
  else if (d.barrios.length > 1) e.push({ color: 'dorado', html: '<p class="w-pre">Recorriste</p><p class="w-grande">' + d.barrios.length + '</p><p class="w-medio">barrios buscando el mejor.</p><div class="w-chips">' + d.barrios.slice(0, 10).map((b) => '<span>' + escapar(b) + '</span>').join('') + '</div>' });
  if (d.n >= 2 && d.km >= 0.2) e.push({ color: 'musgo', html: '<p class="w-pre">Entre buñuelo y buñuelo hiciste</p><p class="w-grande">' + fmtKm(d.km) + '</p><p class="w-medio">kilómetros.</p><p class="w-texto">Más o menos ' + Math.round(d.km * 10) + ' cuadras. Cada buñuelo te lo ganaste.</p>' });
  if (d.racha >= 2) e.push({ color: 'chocolate', html: '<p class="w-pre">Tu racha</p><p class="w-grande">' + d.racha + '</p><p class="w-medio">semanas seguidas anotando.</p><p class="w-texto">Sí, chef. Constancia de cocina.</p>' });
  if (d.conPrecio.length) {
    const comp = d.barato && d.caro && d.caro.precio > d.barato.precio ? '<p class="w-texto">El más barato: ' + escapar(d.barato.nombre) + ' (' + fmtPesos(d.barato.precio) + '). El más caro: ' + escapar(d.caro.nombre) + ' (' + fmtPesos(d.caro.precio) + ').</p>' : '';
    e.push({ color: 'chocolate', html: '<p class="w-pre">Si comiste uno en cada sitio, gastaste unos</p><p class="w-grande">' + fmtPesos(d.gasto) + '</p><p class="w-medio">en buñuelos.</p>' + comp });
  }
  if (d.favorito) e.push({ color: 'masa', html: '<div class="w-bunuelo-grande"><svg viewBox="0 0 100 100" aria-hidden="true"><use href="#bunuelo"/></svg></div><p class="w-pre">Tu favorito</p><p class="w-medio">' + escapar(d.favorito.nombre) + '</p><p class="w-texto">' + escapar(d.favorito.barrio || 'Bogotá') + '. Le diste ' + formatoCal(d.favorito.cal) + ' de 5: ' + textoCal(d.favorito.cal) + '</p>' });
  e.push({ color: 'rojo', html: d.enTop > 0
    ? '<p class="w-pre">De lo que probaste</p><p class="w-grande">' + d.enTop + '</p><p class="w-medio">' + (d.enTop === 1 ? 'está' : 'están') + ' en el Top 10 de Bogotá.</p><p class="w-texto">Tienes buen ojo. O buena muela.</p>'
    : '<p class="w-pre">De lo que probaste</p><p class="w-medio">Nada está en el Top 10.</p><p class="w-texto">Lo tuyo es descubrir. Vota por tus favoritos para que suban.</p>' });
  e.push({ color: 'dorado', html: '<img src="/img/oso-celebra.webp" alt="" style="width:150px;height:auto;margin-bottom:12px">' + '<p class="w-pre">Tu personalidad buñuelera</p><p class="w-medio">' + d.perso.titulo + '</p><p class="w-texto">' + d.perso.texto + '</p>' });
  e.push({ color: 'chocolate', final: true, html: '<div class="w-tarjeta"><h2>Mi temporada en buñuelos</h2><div class="w-stats">' +
    '<div><b>' + d.n + '</b><span>' + sitios + '</span></div><div><b>' + d.barrios.length + '</b><span>' + (d.barrios.length === 1 ? 'barrio' : 'barrios') + '</span></div>' +
    (d.n >= 2 ? '<div><b>' + fmtKm(d.km) + ' km</b><span>recorridos</span></div>' : '') +
    (d.conPrecio.length ? '<div><b>' + fmtPesos(d.gasto) + '</b><span>en buñuelos</span></div>' : '') +
    (d.favorito ? '<div class="ancho"><b>' + escapar(d.favorito.nombre) + '</b><span>mi favorito</span></div>' : '') +
    '</div><p class="w-perso">' + d.perso.titulo + '</p><p class="w-pie">Apetitosos · ¿Dónde está el mejor buñuelo de Bogotá?</p></div>' +
    '<div class="w-acciones"><button type="button" class="w-compartir" id="w-compartir">Compartir</button><button type="button" class="w-repetir" id="w-repetir">Ver otra vez</button></div>' +
    '<p class="w-ayuda">También puedes tomar un pantallazo.</p><textarea id="w-texto-copiar" class="w-copiar" readonly hidden></textarea>' });
  return e;
}
function resumenAbierto() { return modoDemo || hoyBogota() >= CONFIG.resumenDesde; }
function fechaLarga(f) { const [, m, d] = f.split('-').map(Number); return d + ' de ' + MESES_LARGOS[m - 1]; }
function abrirWrapped() {
  if (!resumenAbierto()) { avisar('Paciencia, chef. Tu resumen se sirve el ' + fechaLarga(CONFIG.resumenDesde) + '.'); return; }
  const d = datosResumen();
  if (!d.n) { avisar('Todavía no has anotado buñuelos.'); return; }
  escenas = construirEscenas(d);
  cerrarHojas();
  $('wrapped').hidden = false;
  irAEscena(0);
}
function cerrarWrapped() { $('wrapped').hidden = true; $('w-escena').innerHTML = ''; }
function irAEscena(i) {
  escenaActual = Math.max(0, Math.min(i, escenas.length - 1));
  const esc = escenas[escenaActual], w = $('wrapped');
  w.style.backgroundColor = COLORES[esc.color][0]; w.style.color = COLORES[esc.color][1];
  const escena = $('w-escena');
  escena.classList.remove('entra'); escena.innerHTML = esc.html; void escena.offsetWidth; escena.classList.add('entra');
  const quieta = SIN_MOVIMIENTO || esc.final;
  $('w-progreso').innerHTML = escenas.map((_, j) => '<div class="w-barra' + (j < escenaActual ? ' llena' : '') + (j === escenaActual ? ' actual' + (quieta ? ' quieta' : '') : '') + '" style="--dur:' + DURACION_ESCENA + 'ms"><i></i></div>').join('');
  if (esc.final) { $('w-compartir').addEventListener('click', compartirResumen); $('w-repetir').addEventListener('click', () => irAEscena(0)); }
}
function siguienteEscena() { if (escenaActual < escenas.length - 1) irAEscena(escenaActual + 1); }
function anteriorEscena() { irAEscena(escenaActual - 1); }
async function compartirResumen() {
  const d = datosResumen();
  const texto = 'Mi temporada en buñuelos: probé en ' + d.n + (d.n === 1 ? ' sitio' : ' sitios') + ' de Bogotá' + (d.n >= 2 && d.km >= 0.2 ? ', recorrí ' + fmtKm(d.km) + ' km' : '') +
    (d.favorito ? ' y mi favorito es ' + d.favorito.nombre : '') + '. Mi personalidad buñuelera: ' + d.perso.titulo + '. ¿Dónde está el mejor buñuelo de Bogotá?';
  const url = CONFIG.urlApp || '';
  try { if (navigator.share) { await navigator.share({ title: 'Mi temporada en buñuelos', text: texto, url }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  const completo = texto + (url ? ' ' + url : '');
  try { await navigator.clipboard.writeText(completo); avisar('Copiamos tu resumen. Pégalo donde quieras.'); return; } catch {}
  const area = $('w-texto-copiar'); if (area) { area.hidden = false; area.value = completo; area.focus(); area.select(); }
  avisar('Copia el texto o toma un pantallazo para compartir.');
}
// Para el pitch: con ?demo=wrapped se inventan anotaciones de ejemplo (no se guardan).
function activarDemoWrapped() {
  if (!lugares.length) return;
  modoDemo = true;
  const elegidos = ordenados().slice(0, 12).sort(() => Math.random() - 0.5).slice(0, Math.min(6, lugares.length));
  entradas = elegidos.map((l, i) => ({ id: 'demo' + i, idLugar: l.id, fecha: hoyBogota(20 - i * 3), cal: 2 + Math.floor(Math.random() * 7) / 2, volveria: null, resena: '', creado: Date.now(), provocas: 0 }));
  repintar();
  setTimeout(abrirWrapped, 700);
}

// ---------------- Un solo manejador para todos los toques ----------------
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-accion]');
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.accion) {
    case 'ir': irA(b.dataset.vista); break;
    case 'anotar': abrirAnotar(id || null); break;
    case 'anotar-abierto': if (lugarAbierto) abrirAnotar(lugarAbierto.id); break;
    case 'porprobar-abierto': if (lugarAbierto) alternarPorProbar(lugarAbierto.id); break;
    case 'abrir-lugar': cerrarElegir(); abrirLugar(id); break;
    case 'por-probar': ev.stopPropagation(); alternarPorProbar(id); break;
    case 'votar': votarAbierto(); break;
    case 'cerrar-hojas': cerrarHojas(); break;
    case 'velo': if ($('hoja-elegir').classList.contains('abierta')) cerrarElegir(); else cerrarHojas(); break;
    case 'cerrar-elegir': cerrarElegir(); break;
    case 'mapa-grande': abrirMapaGrande(); break;
    case 'mapa-cerrar': cerrarMapaGrande(); break;
    case 'ubicarme': ubicarme(); break;
    case 'quitar-chip': quitarChip(); break;
    case 'sub-inicio': subInicio = b.dataset.sub; listaAbierta = null; resaltado = null; pintarInicio(); break;
    case 'sub-perfil': subPerfil = b.dataset.sub; pintarPerfil(); break;
    case 'sub-actividad': subActividad = b.dataset.sub; pintarActividad(); break;
    case 'rango': filtroPrecio = b.dataset.rango; guardarLocal(CLAVE_FILTRO, filtroPrecio); pintarInicio(); break;
    case 'ubicar-cerca': pedirUbicacion().then(pintarInicio).catch((err) => avisar(errorUbicacion(err), 'error')); break;
    case 'abrir-lista': listaAbierta = id; pintarInicio(); break;
    case 'abrir-lista-inicio': irA('inicio'); subInicio = 'listas'; listaAbierta = id; pintarInicio(); break;
    case 'volver-listas': listaAbierta = null; pintarInicio(); break;
    case 'lista-mapa': verListaEnMapa(id); break;
    case 'seguir': alternarSeguir(id); break;
    case 'modo-anotar': anotacion.modo = b.dataset.modo; pintarAnotar(); break;
    case 'cal': anotacion.cal = Number(b.dataset.cal); pintarAnotar(); break;
    case 'como-se-calcula': explicarRanking(); break;
    case 'aceptar-datos': aceptarDatos(b); break;
    case 'fecha': anotacion.fecha = b.dataset.fecha; pintarAnotar(); break;
    case 'volveria': { const v = b.dataset.valor === 'si'; anotacion.volveria = anotacion.volveria === v ? null : v; pintarAnotar(); break; }
    case 'elegir-sitio': elegirSitioParaAnotar(); break;
    case 'elegido': { const fn = alElegir; cerrarElegir(); if (fn) fn(id); break; }
    case 'nuevo-desde-anotar': cerrarHojas(); irA('inicio'); abrirMapaGrande(); avisar('Toca el mapa donde está el sitio para agregarlo.'); break;
    case 'guardar-anotacion': guardarAnotacion(); break;
    case 'borrar-entrada': borrarEntrada(); break;
    case 'editar-entrada': { const e = entradas.find((x) => x.id === id); if (e && !modoDemo) abrirAnotar(null, e); break; }
    case 'favorito': elegirFavorito(Number(b.dataset.pos)); break;
    case 'quitar-favorito': cuatro[Number(b.dataset.pos)] = null; guardarLocal(CLAVE_CUATRO, cuatro); guardarCuatroServidor(); cerrarElegir(); pintarPerfil(); break;
    case 'cuenta': abrirCuenta(); break;
    case 'editar-avatar': abrirEditorAvatar(); break;
    case 'invitacion-si': cerrarElegir(); aceptarInvitacionPendiente(); break;
    case 'invitacion-no': cerrarElegir(); guardarLocal(CLAVE_INVITACION, null); nombreInvitador = ''; avisar('Listo. Si cambias de idea, pídele el enlace otra vez.'); repintar(); break;
    case 'orden-probados': ordenProbados = b.dataset.orden; pintarPerfil(); break;
    case 'ver-amigos': verAmigos(); break;
    case 'solicitar': solicitar(id, b); break;
    case 'responder-solicitud': responderSolicitud(id, b.dataset.si === '1'); break;
    case 'agregar-amigo': irA('actividad'); setTimeout(() => $('ba-texto').focus(), 150); break;
    case 'resumen': abrirWrapped(); break;
    case 'modo-cuenta': modoCuenta = b.dataset.modo; pintarActividad(); break;
    case 'salir': salir(); break;
    case 'invitar': invitar(); break;
    case 'compartir-invitacion': compartirInvitacion(); break;
    case 'abrir-amigo': abrirAmigo(id); break;
    case 'quitar-amigo': quitarAmigo(id, b); break;
    case 'provocar': provocar(id); break;
    case 'empezar': $('bienvenida').hidden = true; guardarLocal(CLAVE_BIENVENIDA, true); break;
  }
});
$('form-lugar').addEventListener('submit', enviarNuevo);
$('a-resena').addEventListener('input', () => { $('a-contador').textContent = $('a-resena').value.length + ' / 500'; });
$('buscar-texto').addEventListener('input', pintarBuscar);
$('ba-texto').addEventListener('input', buscarAmigoEscrito);
$('a-cal-rango').addEventListener('input', (e) => { anotacion.cal = Number(e.target.value); pintarAnotar(); });
$('w-cerrar').addEventListener('click', cerrarWrapped);
$('w-adelante').addEventListener('click', siguienteEscena);
$('w-atras').addEventListener('click', anteriorEscena);
$('w-progreso').addEventListener('animationend', siguienteEscena);
document.addEventListener('keydown', (e) => {
  if (!$('wrapped').hidden) {
    if (e.key === 'Escape') cerrarWrapped(); else if (e.key === 'ArrowRight') siguienteEscena(); else if (e.key === 'ArrowLeft') anteriorEscena();
    return;
  }
  if (e.key === 'Escape') {
    if ($('hoja-elegir').classList.contains('abierta')) cerrarElegir();
    else if (hayHojaAbierta()) cerrarHojas();
    else if (mapaGrande) cerrarMapaGrande();
  }
});

// ---------------- Carga ----------------
async function refrescar() {
  if (document.hidden) return;
  try { lugares = await pedir('/api/lugares?plato=' + encodeURIComponent(CONFIG.plato)); sincronizarMarcadores(); } catch {}
  try { listas = await pedir('/api/listas'); } catch {}
  repintar();
}
async function iniciar() {
  if (!CON_SERVIDOR) { mostrarError('Esto es solo el archivo, no la app.', 'La app funciona desde su enlace de Cloudflare (el que termina en workers.dev).'); return; }
  if (!leerLocal(CLAVE_BIENVENIDA, false) && !CONFIG.demoWrapped) $('bienvenida').hidden = false;
  try { Object.assign(CONFIG, await pedir('/api/config')); }
  catch { mostrarError('No pudimos conectarnos con el servidor.', 'Revisa tu conexión a internet y recarga la página.'); return; }
  // ?aliado=alpina muestra cómo se vería el espacio del aliado, solo en ese navegador y sin activarlo para nadie
  if (!CONFIG.aliado && new URLSearchParams(location.search).get('aliado') === 'alpina') CONFIG.aliado = { nombre: 'Alpina', logo: '/img/aliados/alpina.webp', url: '' };
  pintarMarca();
  const pLugares = pedir('/api/lugares?plato=' + encodeURIComponent(CONFIG.plato));
  const pListas = pedir('/api/listas').catch(() => []);
  try { lugares = await pLugares; listas = await pListas; }
  catch { mostrarError('No pudimos cargar los buñuelos.', 'Revisa tu conexión a internet y recarga la página.'); return; }
  $('carga').classList.add('oculta');
  repintar();
  cargarDiario();
  iniciarAmigos();
  if (CONFIG.demoWrapped) activarDemoWrapped();
  else if (CONFIG.abrirResumen) {
    history.replaceState(null, '', location.pathname);
    $('bienvenida').hidden = true;
    irA('perfil');
    // espera a que llegue el diario del servidor antes de abrirlo
    setTimeout(() => {
      if (entradas.length) abrirWrapped();
      else if (!tokenSesion) { resumenPendiente = true; modoCuenta = 'entrar'; irA('actividad'); }
      else avisar('Todavía no has anotado buñuelos.');
    }, 1800);
  }
  iniciarMapa();
  setInterval(() => { refrescar(); cargarYo(); }, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refrescar(); });
}
function iniciarMapa() {
  acomodarMapa();
  if (!CONFIG.mapKey) { $('mapa-caja').innerHTML = '<p class="vacio" style="margin:0;height:100%;display:grid;place-items:center;text-align:center">Falta la clave de MapTiler (MAPTILER_KEY).</p>'; return; }
  if (!window.maptilersdk) { $('mapa-caja').innerHTML = '<p class="vacio" style="margin:0;height:100%;display:grid;place-items:center">No pudimos cargar el mapa.</p>'; return; }
  try {
    maptilersdk.config.apiKey = CONFIG.mapKey;
    const opciones = {
      container: 'mapa', style: 'https://api.maptiler.com/maps/streets-v2/style.json?key=' + encodeURIComponent(CONFIG.mapKey),
      center: [-74.09, 4.655], zoom: 10.8, minZoom: 10, maxZoom: 19, maxBounds: [[-74.4, 4.3], [-73.8, 5.0]],
      navigationControl: false, geolocateControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false
    };
    if (maptilersdk.Language && maptilersdk.Language.SPANISH) opciones.language = maptilersdk.Language.SPANISH;
    mapa = new maptilersdk.Map(opciones);
    if (mapa.touchZoomRotate) mapa.touchZoomRotate.disableRotation();
    acomodarMapa();
    mapa.on('error', (e) => {
      const estado = e && e.error && e.error.status;
      if (!mapaListo && (estado === 401 || estado === 403)) avisar('MapTiler rechazó la clave. Revisa "Allowed HTTP origins" en MapTiler.', 'error');
    });
    mapa.on('click', alTocarMapa);
    mapa.on('moveend', () => { if (vista === 'inicio' && subInicio === 'cerca' && !ultimaPosicion) pintarInicio(); });
    mapa.once('load', () => { calentarEstilo(); mapaListo = true; sincronizarMarcadores(); });
  } catch { avisar('No pudimos cargar el mapa.', 'error'); }
}
iniciar();
