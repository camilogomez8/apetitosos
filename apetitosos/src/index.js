/**
 * Apetitosos · ¿Dónde está el mejor buñuelo de Bogotá? — servidor (Cloudflare Workers).
 *
 * La página (public/index.html) la sirve Cloudflare como archivo estático.
 * Este Worker solo atiende /api/* y guarda todo en D1 (binding DB). Ver README.md.
 *
 * Variables (wrangler.jsonc → vars): MAPTILER_KEY, TURNSTILE_SITE_KEY, URL_APP, CORREO_DESDE, RESUMEN_DESDE
 * Secretos (wrangler secret put …):   IP_SALT, TURNSTILE_SECRET, RESEND_API_KEY
 * Sin TURNSTILE_SECRET no se pide captcha. Sin RESEND_API_KEY no se mandan correos.
 */

const PLATO = 'buñuelo';
const CRON_LIMPIEZA = '17 8 * * *';   // 3:17 a. m. de Bogotá
const DISTANCIA_DUPLICADO_M = 60;
const LIMITES_BOGOTA = { latMin: 4.44, latMax: 4.84, lngMin: -74.23, lngMax: -73.98 };
const PRECIO_MIN = 100;
const PRECIO_MAX = 50000;
const CAL_MAX = 5;
const ACCIONES_POR_DIA = 80;      // votos + sitios + calificaciones por conexión (IP) al día
const SITIOS_POR_DIA = 10;        // sitios nuevos por conexión al día
const MAX_AMIGOS = 200;
const MAX_SOLICITUDES_RECIBIDAS = 50;
const BUSQUEDAS_POR_DIA = 200;    // búsquedas de @usuario por cuenta al día
const CANJES_POR_DIA = 20;        // invitaciones aceptadas por cuenta al día
const INTENTOS_CLAVE = 5;         // intentos fallidos antes de bloquear la cuenta un rato
const MINUTOS_BLOQUEO = 15;
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin 0/O ni 1/I para no confundir

export default {
  // Dos crons (ver wrangler.jsonc → triggers): limpieza diaria y correo del resumen el 31 de diciembre.
  async scheduled(evento, env, ctx) {
    if (evento.cron === CRON_LIMPIEZA) ctx.waitUntil(limpiar(env));
    else ctx.waitUntil(mandarCorreosResumen(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const ruta = request.method + ' ' + url.pathname;
      switch (ruta) {
        case 'GET /api/config': return json(config(env));
        case 'GET /api/lugares': return json(await obtenerLugares(env, url.searchParams.get('plato') || PLATO));
        case 'GET /api/listas': return json(await obtenerListas(env));
        case 'POST /api/votar': return json(await votar(request, env));
        case 'POST /api/lugares': return json(await crearLugar(request, env));
        case 'GET /api/diario': return json(await diario(request, env));
        case 'POST /api/anotar': return json(await anotar(request, env));
        case 'POST /api/entrada/borrar': return json(await borrarEntrada(request, env));
        case 'POST /api/por-probar': return json(await porProbar(request, env));
        case 'POST /api/seguir': return json(await seguirLista(request, env));
        case 'POST /api/provocar': return json(await provocar(request, env));
        case 'GET /api/actividad': return json(await actividad(request, env));
        case 'GET /api/yo': return json(await yo(request, env));
        case 'POST /api/registro': return json(await registrar(request, env));
        case 'POST /api/entrar': return json(await entrar(request, env));
        case 'POST /api/salir': return json(await salirCuenta(request, env));
        case 'POST /api/cuenta': return json(await actualizarCuenta(request, env));
        case 'POST /api/cuatro': return json(await guardarCuatro(request, env));
        case 'POST /api/aceptar-datos': return json(await aceptarDatos(request, env));
        case 'POST /api/avatar': return json(await guardarAvatar(request, env));
        case 'GET /api/perfil-amigo': return json(await perfilAmigo(request, env, url));
        case 'POST /api/invitacion': return json(await verInvitacion(request, env));
        case 'POST /api/perfil': return json(await guardarPerfil(request, env));
        case 'POST /api/amigos': return json(await agregarAmigo(request, env));
        case 'GET /api/buscar-amigo': return json(await buscarAmigo(request, env, url));
        case 'POST /api/solicitud': return json(await mandarSolicitud(request, env));
        case 'POST /api/solicitud/responder': return json(await responderSolicitud(request, env));
        case 'POST /api/amigos/quitar': return json(await quitarAmigo(request, env));
        case 'POST /api/csp': return await reporteCsp(request);
        default: return json({ ok: false, mensaje: 'Ruta desconocida.' }, 404);
      }
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      return json({ ok: false, mensaje: 'Algo falló de nuestro lado. Intenta de nuevo en un momento.' }, 500);
    }
  }
};

// ====================== CONFIG ======================

function config(env) {
  return {
    mapKey: env.MAPTILER_KEY || '',
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
    plato: PLATO,
    limites: LIMITES_BOGOTA,
    distanciaDuplicado: DISTANCIA_DUPLICADO_M,
    resumenDesde: /^\d{4}-\d{2}-\d{2}$/.test(env.RESUMEN_DESDE || '') ? env.RESUMEN_DESDE : '2026-12-31',
    // Aliado comercial ("Con el apoyo de"). Sin ALIADO_NOMBRE no se muestra nada.
    aliado: env.ALIADO_NOMBRE ? { nombre: env.ALIADO_NOMBRE, logo: env.ALIADO_LOGO || '', url: urlSegura(env.ALIADO_URL) } : null,
    // Enlaces legales del pie de página y del registro
    legal: {
      politica: urlSegura(env.URL_POLITICA_DATOS) || 'https://www.elespectador.com/terminos/politica-de-tratamiento-de-datos/',
      terminos: urlSegura(env.URL_TERMINOS) || 'https://www.elespectador.com/terminos/',
      contacto: urlSegura(env.URL_CONTACTO) || 'https://www.elespectador.com/ayuda-el-espectador/'
    }
  };
}

/** Solo direcciones https (o mailto) para los enlaces que salen de la configuración. */
function urlSegura(u) {
  const t = String(u || '').trim();
  return /^(https:\/\/|mailto:)[^\s"'<>]+$/.test(t) ? t : '';
}

// ====================== LECTURA ======================

async function obtenerLugares(env, plato) {
  // nota = promedio de la última calificación de cada persona
  const { results } = await env.DB.prepare(
    "SELECT l.id, l.nombre, l.lat, l.lng, l.barrio, l.precio, l.creado, l.votos, l.probados, n.nota, n.opiniones FROM lugares l " +
    "LEFT JOIN (SELECT id_lugar, ROUND(AVG(cal), 1) AS nota, COUNT(*) AS opiniones FROM (SELECT id_lugar, cal, ROW_NUMBER() OVER (PARTITION BY id_lugar, COALESCE(id_perfil, id_dispositivo) ORDER BY creado DESC, rowid DESC) AS n FROM entradas) WHERE n = 1 GROUP BY id_lugar) n ON n.id_lugar = l.id " +
    "WHERE l.plato = ? AND l.estado = 'visible'"
  ).bind(plato).all();
  return results.map(aLugar);
}

async function obtenerListas(env) {
  const { results } = await env.DB.prepare("SELECT * FROM listas WHERE estado IN ('publicada', 'proximamente') ORDER BY orden LIMIT 100").all();
  return results
    .filter((f) => f.id && f.titulo)
    .map((f) => ({
      id: f.id,
      titulo: f.titulo,
      autor: f.autor || '',
      descripcion: f.descripcion || '',
      fuenteNombre: f.fuente_nombre || '',
      fuenteUrl: /^https:\/\//.test(f.fuente_url || '') ? f.fuente_url : '',
      ids: String(f.ids_lugares || '').split(',').map((s) => s.trim()).filter(Boolean),
      estado: String(f.estado || '').toLowerCase() === 'proximamente' ? 'proximamente' : 'publicada',
      orden: Number(f.orden) || 99
    }));
}

function aLugar(f) {
  return {
    id: f.id,
    nombre: f.nombre,
    lat: Number(f.lat),
    lng: Number(f.lng),
    barrio: f.barrio || '',
    precio: f.precio === null || f.precio === undefined ? null : Number(f.precio),
    creado: Date.parse(f.creado) || 0,
    votos: Number(f.votos) || 0,
    probados: Number(f.probados) || 0,
    nota: f.nota === null || f.nota === undefined ? null : Number(f.nota),
    opiniones: Number(f.opiniones) || 0     // personas que lo calificaron (cuenta su última calificación)
  };
}

async function lugarPorId(env, id) {
  const f = await env.DB.prepare(
    "SELECT l.id, l.nombre, l.lat, l.lng, l.barrio, l.precio, l.creado, l.votos, l.probados, n.nota, n.opiniones FROM lugares l " +
    "LEFT JOIN (SELECT id_lugar, ROUND(AVG(cal), 1) AS nota, COUNT(*) AS opiniones FROM (SELECT id_lugar, cal, ROW_NUMBER() OVER (PARTITION BY id_lugar, COALESCE(id_perfil, id_dispositivo) ORDER BY creado DESC, rowid DESC) AS n FROM entradas WHERE id_lugar = ?1) WHERE n = 1 GROUP BY id_lugar) n ON n.id_lugar = l.id " +
    "WHERE l.id = ?1 AND l.estado = 'visible'"
  ).bind(id).first();
  return f ? aLugar(f) : null;
}

// ====================== VOTAR ======================

async function votar(request, env) {
  const cuerpo = await leerCuerpo(request);
  const idLugar = limpiarTexto(cuerpo.idLugar, 40);
  const idDispositivo = cuerpo.idDispositivo;
  if (!idLugar) return { ok: false, mensaje: 'No encontramos ese sitio. Recarga la página e intenta de nuevo.' };
  if (!dispositivoValido(idDispositivo)) return { ok: false, mensaje: 'No pudimos identificar tu dispositivo. Recarga la página.' };
  const perfil = await perfilDeSolicitud(request, env);
  if (!perfil) return SIN_SESION('votar');

  const control = await controlar(request, env, cuerpo.token, false);
  if (!control.ok) return control;

  const lugar = await lugarPorId(env, idLugar);
  if (!lugar) return { ok: false, mensaje: 'Ese sitio ya no está en el mapa.' };

  // Un voto por persona y por sitio, sin importar desde cuántos teléfonos entre.
  if (await env.DB.prepare('SELECT 1 FROM votos WHERE id_lugar = ? AND id_perfil = ? LIMIT 1').bind(idLugar, perfil.id).first()) {
    return { ok: false, yaVoto: true, lugar, mensaje: 'Ya votaste por este sitio.' };
  }
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO votos (id_lugar, plato, fecha, id_dispositivo, ip_hash, id_perfil) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(idLugar, PLATO, ahora(), idDispositivo, control.ipHash, perfil.id).run();

  if (!r.meta.changes) return { ok: false, yaVoto: true, lugar, mensaje: 'Ya votaste por este sitio desde este teléfono.' };

  await env.DB.prepare('UPDATE lugares SET votos = votos + 1 WHERE id = ?').bind(idLugar).run();
  lugar.votos += 1;
  return { ok: true, lugar };
}

// ====================== CREAR UN SITIO ======================

async function crearLugar(request, env) {
  const cuerpo = await leerCuerpo(request);
  const datos = cuerpo.datos || {};
  const idDispositivo = cuerpo.idDispositivo;
  const nombre = limpiarTexto(datos.nombre, 80);
  const barrio = limpiarTexto(datos.barrio, 60);
  const lat = redondear(Number(datos.lat));
  const lng = redondear(Number(datos.lng));
  const precio = normalizarPrecio(datos.precio);

  if (!dispositivoValido(idDispositivo)) return { ok: false, mensaje: 'No pudimos identificar tu dispositivo. Recarga la página.' };
  if (!nombre) return { ok: false, mensaje: 'Escribe el nombre del sitio.' };
  if (!dentroDeBogota(lat, lng)) return { ok: false, mensaje: 'Ese punto queda por fuera de Bogotá. Marca un sitio dentro de la ciudad.' };
  if (precio === undefined) return { ok: false, mensaje: 'Escribe el precio solo con números, por ejemplo 2500. O déjalo vacío.' };
  const perfil = await perfilDeSolicitud(request, env);
  if (!perfil) return SIN_SESION('agregar sitios');

  const control = await controlar(request, env, cuerpo.token, true);
  if (!control.ok) return control;
  const hoy = await env.DB.prepare("SELECT COUNT(*) AS n FROM votos v JOIN lugares l ON l.id = v.id_lugar AND l.creador = v.id_dispositivo WHERE v.id_perfil = ? AND substr(v.fecha, 1, 10) = ?")
    .bind(perfil.id, ahora().slice(0, 10)).first();
  if (hoy && hoy.n >= SITIOS_POR_DIA) return { ok: false, mensaje: 'Ya marcaste muchos sitios hoy. Vuelve mañana para agregar más.' };

  // Regla de los 60 metros: se buscan sitios en una cajita alrededor del punto (0,001° ≈ 110 m).
  const { results } = await env.DB.prepare(
    "SELECT id, nombre, lat, lng, barrio, precio, creado, votos, probados FROM lugares WHERE plato = ? AND estado = 'visible' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?"
  ).bind(PLATO, lat - 0.001, lat + 0.001, lng - 0.001, lng + 0.001).all();
  let cercano = null, menor = Infinity;
  results.forEach((f) => {
    const d = distanciaMetros(lat, lng, Number(f.lat), Number(f.lng));
    if (d < menor) { menor = d; cercano = f; }
  });
  if (cercano && menor < DISTANCIA_DUPLICADO_M) {
    return { ok: false, duplicado: true, lugar: aLugar(cercano), mensaje: '¿Es este? Ya lo marcaron.' };
  }

  const id = 'L-' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const fecha = ahora();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO lugares (id, nombre, lat, lng, barrio, precio, plato, creado, creador, votos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
    ).bind(id, nombre, lat, lng, barrio, precio, PLATO, fecha, idDispositivo),
    // El registro cuenta como primer voto.
    env.DB.prepare(
      'INSERT INTO votos (id_lugar, plato, fecha, id_dispositivo, ip_hash, id_perfil) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, PLATO, fecha, idDispositivo, control.ipHash, perfil.id)
  ]);

  return {
    ok: true,
    lugar: { id, nombre, lat, lng, barrio, precio, creado: Date.parse(fecha), votos: 1, probados: 0 }
  };
}

// ====================== DIARIO ======================
// Cada vez que alguien come en un sitio queda una entrada con fecha, puntaje (de media en media),
// "¿volverías?" y una reseña opcional. Todo lo que se escribe exige cuenta y queda guardado con su id_perfil:
// el teléfono (id_dispositivo) ya no sirve como llave para leer ni para tocar el diario de nadie.

const RESENA_MAX = 500;
const SIN_SESION = (para) => ({ ok: false, sesion: true, mensaje: 'Entra a tu cuenta para ' + para + '.' });

/** Perfil de quien hace la petición, o null si no tiene sesión. */
async function perfilDeSolicitud(request, env) {
  const usuario = await usuarioDe(request, env);
  return usuario ? perfilDe(env, usuario.id) : null;
}

function aEntrada(f) {
  return {
    id: f.id, idLugar: f.id_lugar, fecha: f.fecha, cal: Number(f.cal),
    volveria: f.volveria === null || f.volveria === undefined ? null : !!f.volveria,
    resena: f.resena || '', creado: Date.parse(f.creado) || 0, provocas: Number(f.provocas) || 0
  };
}

async function diario(request, env) {
  const perfil = await perfilDeSolicitud(request, env);
  if (!perfil) return { ok: false, sesion: true };
  const [e, p, s, v] = await env.DB.batch([
    env.DB.prepare('SELECT e.*, (SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id) AS provocas FROM entradas e WHERE id_perfil = ? ORDER BY fecha DESC, creado DESC LIMIT 1000').bind(perfil.id),
    env.DB.prepare('SELECT id_lugar, MAX(fecha) AS fecha FROM por_probar WHERE id_perfil = ? GROUP BY id_lugar ORDER BY fecha DESC LIMIT 500').bind(perfil.id),
    env.DB.prepare('SELECT DISTINCT id_lista FROM seguimientos WHERE id_perfil = ? LIMIT 200').bind(perfil.id),
    env.DB.prepare('SELECT DISTINCT id_lugar FROM votos WHERE id_perfil = ? LIMIT 1000').bind(perfil.id)
  ]);
  return {
    ok: true,
    votados: v.results.map((f) => f.id_lugar),
    cuatro: leerCuatro(perfil.cuatro),
    entradas: e.results.map(aEntrada),
    porProbar: p.results.map((f) => ({ idLugar: f.id_lugar, fecha: Date.parse(f.fecha) || 0 })),
    seguidas: s.results.map((f) => f.id_lista)
  };
}

function fechaValida(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto || '')) return false;
  const d = Date.parse(texto + 'T12:00:00-05:00');
  return Number.isFinite(d) && texto >= '2020-01-01' && texto <= ahora().slice(0, 10);
}

async function anotar(request, env) {
  const cuerpo = await leerCuerpo(request);
  const idDispositivo = cuerpo.idDispositivo;
  const idLugar = limpiarTexto(cuerpo.idLugar, 40);
  const cal = Number(cuerpo.cal);
  const fecha = String(cuerpo.fecha || '');
  const resena = limpiarTexto(cuerpo.resena, RESENA_MAX);
  const volveria = cuerpo.volveria === true ? 1 : (cuerpo.volveria === false ? 0 : null);
  if (!dispositivoValido(idDispositivo)) return { ok: false, mensaje: 'No pudimos identificar tu dispositivo. Recarga la página.' };
  if (!idLugar) return { ok: false, mensaje: 'Elige el sitio.' };
  if (!(cal >= 0.5 && cal <= CAL_MAX && Number.isInteger(cal * 2))) return { ok: false, mensaje: 'Elige qué tal estaba, de medio a 5 buñuelos.' };
  if (!fechaValida(fecha)) return { ok: false, mensaje: 'Revisa la fecha: no puede ser en el futuro.' };
  const perfil = await perfilDeSolicitud(request, env);
  if (!perfil) return SIN_SESION('anotar tus buñuelos');

  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  const lugar = await lugarPorId(env, idLugar);
  if (!lugar) return { ok: false, mensaje: 'Ese sitio ya no está en el mapa.' };

  // Editar una entrada que ya existe
  if (cuerpo.id) {
    const id = limpiarTexto(cuerpo.id, 40);
    const r = await env.DB.prepare('UPDATE entradas SET fecha = ?, cal = ?, volveria = ?, resena = ? WHERE id = ? AND id_lugar = ? AND id_perfil = ?')
      .bind(fecha, cal, volveria, resena || null, id, idLugar, perfil.id).run();
    if (!r.meta.changes) return { ok: false, mensaje: 'No encontramos esa anotación.' };
    const f = await env.DB.prepare('SELECT e.*, (SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id) AS provocas FROM entradas e WHERE id = ?').bind(id).first();
    return { ok: true, nueva: false, entrada: aEntrada(f), lugar: await lugarPorId(env, idLugar) };
  }

  const yaHabia = await env.DB.prepare('SELECT 1 FROM entradas WHERE id_lugar = ? AND id_perfil = ? LIMIT 1').bind(idLugar, perfil.id).first();
  const id = 'E-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const creado = ahora();
  const ops = [
    env.DB.prepare('INSERT INTO entradas (id, id_lugar, plato, id_dispositivo, fecha, cal, volveria, resena, creado, ip_hash, id_perfil) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, idLugar, PLATO, idDispositivo, fecha, cal, volveria, resena || null, creado, control.ipHash, perfil.id),
    // Si estaba en "Por probar", ya no
    env.DB.prepare('DELETE FROM por_probar WHERE id_perfil = ? AND id_lugar = ?').bind(perfil.id, idLugar)
  ];
  if (!yaHabia) ops.push(env.DB.prepare('UPDATE lugares SET probados = probados + 1 WHERE id = ?').bind(idLugar));
  await env.DB.batch(ops);
  return {
    ok: true, nueva: true,
    entrada: { id, idLugar, fecha, cal, volveria: volveria === null ? null : !!volveria, resena, creado: Date.parse(creado), provocas: 0 },
    lugar: await lugarPorId(env, idLugar)
  };
}

async function borrarEntrada(request, env) {
  const cuerpo = await leerCuerpo(request);
  const perfil = await perfilDeSolicitud(request, env);
  if (!perfil) return SIN_SESION('borrar anotaciones');
  const id = limpiarTexto(cuerpo.id, 40);
  const f = await env.DB.prepare('SELECT id_lugar FROM entradas WHERE id = ? AND id_perfil = ?').bind(id, perfil.id).first();
  if (!f) return { ok: false, mensaje: 'No encontramos esa anotación.' };
  await env.DB.batch([
    env.DB.prepare('DELETE FROM entradas WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM provocas WHERE id_entrada = ?').bind(id)
  ]);
  const quedan = await env.DB.prepare('SELECT 1 FROM entradas WHERE id_lugar = ? AND id_perfil = ? LIMIT 1').bind(f.id_lugar, perfil.id).first();
  if (!quedan) await env.DB.prepare('UPDATE lugares SET probados = MAX(probados - 1, 0) WHERE id = ?').bind(f.id_lugar).run();
  return { ok: true, lugar: await lugarPorId(env, f.id_lugar) };
}

async function porProbar(request, env) {
  const cuerpo = await leerCuerpo(request);
  const idDispositivo = cuerpo.idDispositivo;
  const idLugar = limpiarTexto(cuerpo.idLugar, 40);
  if (!dispositivoValido(idDispositivo) || !idLugar) return { ok: false, mensaje: 'No pudimos guardar eso. Recarga la página.' };
  const perfil = await perfilDeSolicitud(request, env);
  if (!perfil) return SIN_SESION('guardar sitios en Por probar');
  if (cuerpo.quitar) {
    await env.DB.prepare('DELETE FROM por_probar WHERE id_lugar = ? AND id_perfil = ?').bind(idLugar, perfil.id).run();
    return { ok: true };
  }
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  if (!(await lugarPorId(env, idLugar))) return { ok: false, mensaje: 'Ese sitio ya no está en el mapa.' };
  if (!(await env.DB.prepare('SELECT 1 FROM por_probar WHERE id_lugar = ? AND id_perfil = ?').bind(idLugar, perfil.id).first())) {
    await env.DB.prepare('INSERT OR IGNORE INTO por_probar (id_dispositivo, id_lugar, plato, fecha, id_perfil) VALUES (?, ?, ?, ?, ?)')
      .bind(idDispositivo, idLugar, PLATO, ahora(), perfil.id).run();
  }
  return { ok: true };
}

async function seguirLista(request, env) {
  const cuerpo = await leerCuerpo(request);
  const idDispositivo = cuerpo.idDispositivo;
  const idLista = limpiarTexto(cuerpo.idLista, 60);
  if (!dispositivoValido(idDispositivo) || !idLista) return { ok: false, mensaje: 'No pudimos guardar eso.' };
  const perfil = await perfilDeSolicitud(request, env);
  if (!perfil) return SIN_SESION('seguir listas');
  if (cuerpo.quitar) {
    await env.DB.prepare('DELETE FROM seguimientos WHERE id_lista = ? AND id_perfil = ?').bind(idLista, perfil.id).run();
    return { ok: true };
  }
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  if (!(await env.DB.prepare('SELECT 1 FROM seguimientos WHERE id_lista = ? AND id_perfil = ?').bind(idLista, perfil.id).first())) {
    await env.DB.prepare('INSERT OR IGNORE INTO seguimientos (id_dispositivo, id_lista, fecha, id_perfil) VALUES (?, ?, ?, ?)').bind(idDispositivo, idLista, ahora(), perfil.id).run();
  }
  return { ok: true };
}

/** "Me provoca": solo entre amigos y con cuenta. */
async function provocar(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Entra a tu cuenta para darle "me provoca".' };
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ok: false, sinPerfil: true, mensaje: 'Primero elige tu nombre.' };
  const cuerpo = await leerCuerpo(request);
  const id = limpiarTexto(cuerpo.idEntrada, 40);
  const dueno = await env.DB.prepare('SELECT id_perfil FROM entradas WHERE id = ?').bind(id).first();
  if (!dueno || !dueno.id_perfil) return { ok: false, mensaje: 'Esa anotación ya no existe.' };
  if (dueno.id_perfil === perfil.id) return { ok: false, mensaje: 'Es tu propia reseña.' };
  const amigos = await env.DB.prepare('SELECT 1 FROM amistades WHERE a = ? AND b = ?').bind(perfil.id, dueno.id_perfil).first();
  if (!amigos) return { ok: false, mensaje: 'Solo puedes darle "me provoca" a tus amigos.' };
  if (cuerpo.quitar) await env.DB.prepare('DELETE FROM provocas WHERE id_entrada = ? AND id_perfil = ?').bind(id, perfil.id).run();
  else await env.DB.prepare('INSERT OR IGNORE INTO provocas (id_entrada, id_perfil, fecha) VALUES (?, ?, ?)').bind(id, perfil.id, ahora()).run();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM provocas WHERE id_entrada = ?').bind(id).first();
  return { ok: true, provocas: n.n, mio: !cuerpo.quitar };
}

/** Lo último de tus amigos (y tuyo): anotaciones y lo que agregaron a "Por probar". */
async function actividad(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true };
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ok: false, sinPerfil: true };
  const desde = diasAtras(60);
  const [e, p] = await env.DB.batch([
    env.DB.prepare(
      'SELECT e.*, pf.id AS id_perfil, pf.nombre, pf.avatar, ' +
      '(SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id) AS provocas, ' +
      '(SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id AND v.id_perfil = ?1) AS mio ' +
      'FROM entradas e JOIN perfiles pf ON pf.id = e.id_perfil ' +
      'WHERE (e.id_perfil = ?1 OR e.id_perfil IN (SELECT b FROM amistades WHERE a = ?1)) AND e.creado >= ?2 ORDER BY e.creado DESC LIMIT 60'
    ).bind(perfil.id, desde),
    env.DB.prepare(
      'SELECT pp.id_lugar, pp.fecha, pf.id AS id_perfil, pf.nombre, pf.avatar FROM por_probar pp JOIN perfiles pf ON pf.id = pp.id_perfil ' +
      'WHERE pp.id_perfil IN (SELECT b FROM amistades WHERE a = ?1) AND pp.fecha >= ?2 ORDER BY pp.fecha DESC LIMIT 30'
    ).bind(perfil.id, desde)
  ]);
  const eventos = e.results.map((f) => Object.assign(aEntrada(f), {
    tipo: 'anoto', idPerfil: f.id_perfil, nombre: f.nombre, avatar: leerAvatar(f.avatar), propio: f.id_perfil === perfil.id, mio: !!f.mio
  })).concat(p.results.map((f) => ({
    tipo: 'por_probar', idLugar: f.id_lugar, idPerfil: f.id_perfil, nombre: f.nombre, avatar: leerAvatar(f.avatar), propio: false, creado: Date.parse(f.fecha) || 0
  })));
  eventos.sort((a, b) => b.creado - a.creado);
  return { ok: true, eventos: eventos.slice(0, 80) };
}

// ====================== CUENTAS PROPIAS (usuario y contraseña) ======================
// La contraseña nunca se guarda: se guarda una huella (PBKDF2 con sal propia, 100.000 vueltas).
// La sesión es un token al azar que vive en el teléfono. En la base solo queda su huella.

const PREFIJO_SESION = 'bm_';
const DIAS_SESION = 180;
const VUELTAS_CLAVE = 100000;     // el máximo que permite Cloudflare Workers

function aHex(buf) { return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join(''); }
function alAzar(n) { return aHex(crypto.getRandomValues(new Uint8Array(n))); }

async function huellaClave(clave, sal) {
  const llave = await crypto.subtle.importKey('raw', new TextEncoder().encode(clave), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(sal), iterations: VUELTAS_CLAVE }, llave, 256);
  return aHex(bits);
}
function igualesSeguro(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function nuevaSesion(env, idPerfil) {
  const token = PREFIJO_SESION + alAzar(32);
  const vence = new Date(Date.now() + DIAS_SESION * 86400000).toISOString();
  await env.DB.prepare('INSERT INTO sesiones (token_hash, id_perfil, creado, vence) VALUES (?, ?, ?, ?)')
    .bind(await hash(token), idPerfil, ahora(), vence).run();
  return token;
}
async function usuarioDeSesionPropia(env, token) {
  const f = await env.DB.prepare('SELECT id_perfil, vence FROM sesiones WHERE token_hash = ?').bind(await hash(token)).first();
  if (!f || Date.parse(f.vence) < Date.now()) return null;
  return { id: f.id_perfil };
}
function limpiarUsuario(u) { return String(u || '').trim().toLowerCase().replace(/^@/, ''); }
function correoValido(c) { return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(c); }

async function registrar(request, env) {
  const cuerpo = await leerCuerpo(request);
  const usuario = limpiarUsuario(cuerpo.usuario);
  const clave = String(cuerpo.clave || '');
  const nombre = limpiarTexto(cuerpo.nombre, 30);
  const correo = String(cuerpo.correo || '').trim().toLowerCase().slice(0, 254);
  if (nombre.length < 2) return { ok: false, campo: 'nombre', mensaje: 'Escribe cómo quieres que te vean tus amigos (mínimo 2 letras).' };
  if (!/^[a-z0-9._]{3,20}$/.test(usuario)) return { ok: false, campo: 'usuario', mensaje: 'El usuario debe tener entre 3 y 20 caracteres: letras sin tildes, números, punto o guion bajo.' };
  if (clave.length < 8) return { ok: false, campo: 'clave', mensaje: 'La contraseña debe tener al menos 8 caracteres.' };
  if (clave.length > 200) return { ok: false, campo: 'clave', mensaje: 'Esa contraseña es demasiado larga.' };
  if (correo && !correoValido(correo)) return { ok: false, campo: 'correo', mensaje: 'Revisa el correo: parece que le falta algo.' };
  // Ley 1581 de 2012: la autorización para tratar datos personales tiene que ser previa y expresa.
  if (cuerpo.acepta !== true) return { ok: false, campo: 'acepta', mensaje: 'Para crear tu cuenta tienes que aceptar la política de tratamiento de datos.' };

  // Con TURNSTILE_SECRET puesto, crear cuenta pide captcha. Siempre cuenta para el tope diario por conexión.
  const control = await controlar(request, env, cuerpo.token, false, false);
  if (!control.ok) return control;
  if (await env.DB.prepare('SELECT 1 FROM cuentas WHERE usuario = ?').bind(usuario).first()) {
    return { ok: false, campo: 'usuario', mensaje: 'Ese usuario ya existe. Prueba con otro.' };
  }
  const idPerfil = 'u-' + crypto.randomUUID();
  const sal = alAzar(16);
  const creado = ahora();
  let codigo = nuevoCodigo();
  for (let i = 0; i < 4 && await env.DB.prepare('SELECT 1 FROM perfiles WHERE codigo = ?').bind(codigo).first(); i++) codigo = nuevoCodigo();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO perfiles (id, nombre, color, codigo, creado) VALUES (?, ?, ?, ?, ?)').bind(idPerfil, nombre, 'dorado', codigo, creado),
      env.DB.prepare('INSERT INTO cuentas (id_perfil, usuario, clave_hash, sal, correo, avisar, creado, acepto_datos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(idPerfil, usuario, await huellaClave(clave, sal), sal, correo || null, correo && cuerpo.avisar ? 1 : 0, creado, creado)
    ]);
  } catch {
    return { ok: false, campo: 'usuario', mensaje: 'Ese usuario ya existe. Prueba con otro.' };
  }
  const reclamo = await reclamarDispositivo(env, idPerfil, cuerpo.idDispositivo);
  return { ok: true, token: await nuevaSesion(env, idPerfil), perfil: await perfilDe(env, idPerfil), dispositivoAjeno: reclamo.ajeno };
}

async function entrar(request, env) {
  const cuerpo = await leerCuerpo(request);
  const usuario = limpiarUsuario(cuerpo.usuario);
  const clave = String(cuerpo.clave || '').slice(0, 200);
  if (!usuario || !clave) return { ok: false, mensaje: 'Escribe tu usuario y tu contraseña.' };
  // Cada intento cuenta para el tope diario por conexión y, con TURNSTILE_SECRET, pide captcha.
  const control = await controlar(request, env, cuerpo.token, false, false);
  if (!control.ok) return control;
  const c = await env.DB.prepare('SELECT id_perfil, clave_hash, sal, intentos, bloqueo_hasta FROM cuentas WHERE usuario = ?').bind(usuario).first();
  // Bloqueo por cuenta: tras INTENTOS_CLAVE fallos seguidos, la cuenta no acepta contraseñas por MINUTOS_BLOQUEO.
  if (c && c.bloqueo_hasta && Date.parse(c.bloqueo_hasta) > Date.now()) {
    return { ok: false, bloqueada: true, mensaje: 'Hubo demasiados intentos con esta cuenta. Espera ' + MINUTOS_BLOQUEO + ' minutos e intenta de nuevo.' };
  }
  const huella = await huellaClave(clave, c ? c.sal : 'sin-cuenta');
  if (!c || !igualesSeguro(huella, c.clave_hash)) {
    if (c) {
      const fallos = (Number(c.intentos) || 0) + 1;
      const bloquear = fallos >= INTENTOS_CLAVE;
      await env.DB.prepare('UPDATE cuentas SET intentos = ?, bloqueo_hasta = ? WHERE id_perfil = ?')
        .bind(bloquear ? 0 : fallos, bloquear ? new Date(Date.now() + MINUTOS_BLOQUEO * 60000).toISOString() : null, c.id_perfil).run();
    }
    return { ok: false, mensaje: 'El usuario o la contraseña no coinciden.' };
  }
  if (c.intentos || c.bloqueo_hasta) await env.DB.prepare('UPDATE cuentas SET intentos = 0, bloqueo_hasta = NULL WHERE id_perfil = ?').bind(c.id_perfil).run();
  const reclamo = await reclamarDispositivo(env, c.id_perfil, cuerpo.idDispositivo);
  return { ok: true, token: await nuevaSesion(env, c.id_perfil), perfil: await perfilDe(env, c.id_perfil), dispositivoAjeno: reclamo.ajeno };
}

async function salirCuenta(request, env) {
  const cabecera = request.headers.get('Authorization') || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';
  if (token.startsWith(PREFIJO_SESION)) await env.DB.prepare('DELETE FROM sesiones WHERE token_hash = ?').bind(await hash(token)).run();
  return { ok: true };
}

async function actualizarCuenta(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Tu sesión se cerró. Entra otra vez.' };
  const cuerpo = await leerCuerpo(request);
  const nombre = limpiarTexto(cuerpo.nombre, 30);
  const correo = String(cuerpo.correo || '').trim().toLowerCase().slice(0, 254);
  if (nombre.length < 2) return { ok: false, campo: 'nombre', mensaje: 'Escribe al menos 2 letras.' };
  if (correo && !correoValido(correo)) return { ok: false, campo: 'correo', mensaje: 'Revisa el correo: parece que le falta algo.' };
  const ops = [env.DB.prepare('UPDATE perfiles SET nombre = ? WHERE id = ?').bind(nombre, usuario.id)];
  ops.push(env.DB.prepare('UPDATE cuentas SET correo = ?, avisar = ? WHERE id_perfil = ?').bind(correo || null, correo && cuerpo.avisar ? 1 : 0, usuario.id));
  await env.DB.batch(ops);
  return { ok: true, perfil: await perfilDe(env, usuario.id) };
}

// ====================== PERFIL DE UN AMIGO Y "MIS CUATRO" ======================

/** Cuentas creadas antes de la casilla de datos: aceptan la política una vez y queda la fecha. */
async function aceptarDatos(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Tu sesión se cerró. Entra otra vez.' };
  await env.DB.prepare('UPDATE cuentas SET acepto_datos = ? WHERE id_perfil = ? AND acepto_datos IS NULL').bind(ahora(), usuario.id).run();
  return { ok: true };
}

async function guardarAvatar(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Tu sesión se cerró. Entra otra vez.' };
  const avatar = leerAvatar((await leerCuerpo(request)).avatar);
  if (!avatar) return { ok: false, mensaje: 'Elige un personaje.' };
  await env.DB.prepare('UPDATE perfiles SET avatar = ? WHERE id = ?').bind(JSON.stringify(avatar), usuario.id).run();
  return { ok: true, avatar };
}

async function guardarCuatro(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true };
  const cuerpo = await leerCuerpo(request);
  const cuatro = leerCuatro(JSON.stringify(cuerpo.cuatro));
  if (!cuatro) return { ok: false, mensaje: 'No pudimos guardar tus cuatro.' };
  await env.DB.prepare('UPDATE perfiles SET cuatro = ? WHERE id = ?').bind(JSON.stringify(cuatro), usuario.id).run();
  return { ok: true };
}

/** Solo entre amigos: su diario, su Por probar, sus cuatro y cuántos amigos tiene. */
async function perfilAmigo(request, env, url) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Entra a tu cuenta para ver perfiles.' };
  const idAmigo = limpiarTexto(url.searchParams.get('id'), 80);
  const amistad = await env.DB.prepare('SELECT 1 FROM amistades WHERE a = ? AND b = ?').bind(usuario.id, idAmigo).first();
  if (!amistad) return { ok: false, mensaje: 'Solo puedes ver el perfil de tus amigos.' };
  const amigo = await env.DB.prepare('SELECT * FROM perfiles WHERE id = ?').bind(idAmigo).first();
  if (!amigo) return { ok: false, mensaje: 'Ese perfil ya no existe.' };
  const [e, p, n, cu] = await env.DB.batch([
    env.DB.prepare(
      'SELECT e.*, (SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id) AS provocas, ' +
      '(SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id AND v.id_perfil = ?) AS mio ' +
      'FROM entradas e WHERE e.id_perfil = ? ORDER BY e.fecha DESC, e.creado DESC LIMIT 500'
    ).bind(usuario.id, idAmigo),
    env.DB.prepare('SELECT id_lugar, MAX(fecha) AS fecha FROM por_probar WHERE id_perfil = ? GROUP BY id_lugar ORDER BY fecha DESC LIMIT 500').bind(idAmigo),
    env.DB.prepare('SELECT COUNT(*) AS n FROM amistades WHERE a = ?').bind(idAmigo),
    env.DB.prepare('SELECT usuario FROM cuentas WHERE id_perfil = ?').bind(idAmigo)
  ]);
  return {
    ok: true,
    perfil: { id: amigo.id, nombre: amigo.nombre, usuario: cu.results[0] ? cu.results[0].usuario : null, avatar: leerAvatar(amigo.avatar), cuatro: leerCuatro(amigo.cuatro), amigos: n.results[0].n },
    entradas: e.results.map((f) => Object.assign(aEntrada(f), { mio: !!f.mio })),
    porProbar: p.results.map((f) => ({ idLugar: f.id_lugar, fecha: Date.parse(f.fecha) || 0 }))
  };
}

// ====================== CORREO DEL RESUMEN (31 de diciembre) ======================
// Se activa solo si están RESEND_API_KEY (secreto), CORREO_DESDE y URL_APP.
// El cron corre cada hora del 31 de diciembre y manda hasta 40 correos por vuelta
// (Cloudflare gratis permite 50 llamadas hacia afuera por vuelta).

async function mandarCorreosResumen(env) {
  if (!env.RESEND_API_KEY || !env.CORREO_DESDE || !env.URL_APP) return 0;
  // Solo desde el día del resumen y desde las 9 a. m. de Bogotá (UTC−5, sin horario de verano)
  const bogota = new Date(Date.now() - 5 * 3600000).toISOString();
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(env.RESUMEN_DESDE || '') ? env.RESUMEN_DESDE : '2026-12-31';
  if (bogota.slice(0, 10) < desde || Number(bogota.slice(11, 13)) < 9) return 0;
  // Primero los que nunca se intentaron. Los que no tenían anotaciones se vuelven a revisar si sobra cupo,
  // por si anotaron después.
  const { results } = await env.DB.prepare(
    'SELECT c.id_perfil, c.correo, p.nombre, ' +
    '(SELECT COUNT(DISTINCT e.id_lugar) FROM entradas e WHERE e.id_perfil = c.id_perfil) AS sitios ' +
    "FROM cuentas c JOIN perfiles p ON p.id = c.id_perfil WHERE c.avisar = 1 AND c.correo IS NOT NULL AND (c.avisado IS NULL OR c.avisado = 'sin-datos') " +
    'ORDER BY (c.avisado IS NOT NULL) LIMIT 40'
  ).all();
  let enviados = 0;
  for (const f of results) {
    if (!f.sitios) {   // sin anotaciones no hay resumen que mandar (todavía)
      await env.DB.prepare('UPDATE cuentas SET avisado = ? WHERE id_perfil = ?').bind('sin-datos', f.id_perfil).run();
      continue;
    }
    // Se marca ANTES de enviar: si el Worker se cae a mitad de camino, nadie recibe el correo dos veces.
    const marca = await env.DB.prepare("UPDATE cuentas SET avisado = 'enviando' WHERE id_perfil = ? AND (avisado IS NULL OR avisado = 'sin-datos')").bind(f.id_perfil).run();
    if (!marca.meta.changes) continue;
    const enlace = env.URL_APP.replace(/\/$/, '') + '/?resumen=1';
    const texto = 'Hola, ' + f.nombre + '. Este diciembre anotaste ' + f.sitios + (f.sitios === 1 ? ' buñuelo' : ' buñuelos') + ' en Apetitosos. Tu resumen ya está listo: ' + enlace;
    const html = '<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#312A20">' +
      '<p>Hola, ' + escaparHtml(f.nombre) + '.</p><p>Este diciembre anotaste ' + f.sitios + (f.sitios === 1 ? ' buñuelo' : ' buñuelos') + ' en Apetitosos. Tu resumen ya está listo.</p>' +
      '<p><a href="' + escaparHtml(enlace) + '" style="display:inline-block;padding:14px 22px;border-radius:28px;background:#F2C230;color:#312A20;font-weight:bold;text-decoration:none">Ver mi resumen buñuelero</a></p></div>';
    let bien = false;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json', 'Idempotency-Key': 'resumen-' + desde + '-' + f.id_perfil },
        body: JSON.stringify({ from: env.CORREO_DESDE, to: [f.correo], subject: 'Tu temporada en buñuelos ya está servida', text: texto, html })
      });
      bien = r.ok;
    } catch (e) {
      console.error('correo del resumen', f.id_perfil, e && e.message);
    }
    // Un destinatario que falla no detiene a los demás: vuelve a la fila para la próxima vuelta.
    await env.DB.prepare('UPDATE cuentas SET avisado = ? WHERE id_perfil = ?').bind(bien ? ahora() : null, f.id_perfil).run();
    if (bien) enviados++;
  }
  return enviados;
}

/** Limpieza diaria: sesiones vencidas, conteos viejos y bloqueos de clave que ya pasaron. */
async function limpiar(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sesiones WHERE vence < ?').bind(new Date().toISOString()),
    env.DB.prepare('DELETE FROM limites WHERE dia < ?').bind(diasAtras(3)),
    env.DB.prepare('UPDATE cuentas SET bloqueo_hasta = NULL, intentos = 0 WHERE bloqueo_hasta IS NOT NULL AND bloqueo_hasta < ?').bind(new Date().toISOString())
  ]);
}

/** Informes de la Content-Security-Policy (por ahora en modo solo-informe): quedan en los registros del Worker. */
async function reporteCsp(request) {
  const texto = (await request.text().catch(() => '')).slice(0, 2000);
  console.warn('csp', texto);
  return new Response(null, { status: 204 });
}
function escaparHtml(t) { return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ====================== CUENTAS Y AMIGOS ======================
// Cuentas propias (usuario y contraseña). El cliente manda "Authorization: Bearer bm_…".

async function usuarioDe(request, env) {
  const cabecera = request.headers.get('Authorization') || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';
  if (!token.startsWith(PREFIJO_SESION) || token.length > 200) return null;
  return usuarioDeSesionPropia(env, token);
}

function aPerfil(f) { return f ? { id: f.id, nombre: f.nombre, color: f.color, codigo: f.codigo, cuatro: f.cuatro || null, avatar: leerAvatar(f.avatar) } : null; }

// Avatar: personaje + gesto + color del círculo + frase corta. Se guarda como JSON en perfiles.avatar.
const PERSONAJES = ['oso', 'zorro', 'perro', 'coneja', 'gata'];
const FONDOS = ['mostaza', 'salvia', 'naranja', 'arena', 'rojo'];
function leerAvatar(t) {
  let a = t;
  if (typeof t === 'string') { try { a = JSON.parse(t); } catch { return null; } }
  if (!a || typeof a !== 'object' || !PERSONAJES.includes(a.p)) return null;
  return {
    p: a.p,
    g: a.g === 1 ? 1 : 0,
    f: FONDOS.includes(a.f) ? a.f : 'mostaza',
    frase: limpiarTexto(a.frase, 60)
  };
}
function leerCuatro(t) { try { const a = JSON.parse(t || 'null'); return Array.isArray(a) && a.length === 4 ? a.map((x) => (typeof x === 'string' ? x.slice(0, 40) : null)) : null; } catch { return null; } }

async function perfilDe(env, idUsuario) {
  return aPerfil(await env.DB.prepare('SELECT * FROM perfiles WHERE id = ?').bind(idUsuario).first());
}

/**
 * Al crear cuenta o entrar, el teléfono se une a la cuenta y lo que se anotó en él SIN cuenta (antes de que
 * fuera obligatoria) pasa a esa cuenta. Un teléfono que ya pertenece a otra cuenta NUNCA cambia de dueño:
 * en ese caso se responde ajeno = true y el navegador estrena un id nuevo.
 */
async function reclamarDispositivo(env, idPerfil, idDispositivo) {
  if (!dispositivoValido(idDispositivo)) return { ajeno: false };
  await env.DB.prepare('INSERT INTO perfil_dispositivos (id_dispositivo, id_perfil, fecha) VALUES (?, ?, ?) ON CONFLICT(id_dispositivo) DO NOTHING')
    .bind(idDispositivo, idPerfil, ahora()).run();
  const dueno = await env.DB.prepare('SELECT id_perfil FROM perfil_dispositivos WHERE id_dispositivo = ?').bind(idDispositivo).first();
  if (!dueno || dueno.id_perfil !== idPerfil) return { ajeno: true };
  await env.DB.batch(['entradas', 'por_probar', 'seguimientos', 'votos'].map((t) =>
    env.DB.prepare('UPDATE ' + t + ' SET id_perfil = ? WHERE id_dispositivo = ? AND id_perfil IS NULL').bind(idPerfil, idDispositivo)));
  return { ajeno: false };
}

/** Calificaciones de una o varias cuentas, sumando todos sus teléfonos (gana la más reciente). */
function agruparProbados(filas) {
  const porPerfil = {};
  filas.forEach((f) => {
    const p = porPerfil[f.id_perfil] || (porPerfil[f.id_perfil] = {});
    const fecha = Date.parse(f.fecha) || 0;
    if (!p[f.id_lugar] || p[f.id_lugar].fecha < fecha) p[f.id_lugar] = { cal: Number(f.calificacion), fecha };
  });
  return porPerfil;
}

async function amigosDe(env, idPerfil) {
  const [lista, prob] = await env.DB.batch([
    env.DB.prepare('SELECT p.id, p.nombre, p.color, p.avatar, c.usuario, a.fecha FROM amistades a JOIN perfiles p ON p.id = a.b LEFT JOIN cuentas c ON c.id_perfil = p.id WHERE a.a = ? ORDER BY p.nombre').bind(idPerfil),
    env.DB.prepare(
      'SELECT e.id_perfil, e.id_lugar, e.cal AS calificacion, e.creado AS fecha FROM amistades a ' +
      'JOIN entradas e ON e.id_perfil = a.b WHERE a.a = ? LIMIT 5000'
    ).bind(idPerfil)
  ]);
  const porPerfil = agruparProbados(prob.results);
  return lista.results.map((f) => ({ id: f.id, nombre: f.nombre, usuario: f.usuario || null, color: f.color, avatar: leerAvatar(f.avatar), desde: Date.parse(f.fecha) || 0, probados: porPerfil[f.id] || {} }));
}

async function yo(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: true, activo: true, conectado: false };
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ok: true, activo: true, conectado: true, perfil: null };
  const [amigos, cuenta, solicitudes] = await Promise.all([
    amigosDe(env, perfil.id),
    env.DB.prepare('SELECT usuario, correo, avisar, acepto_datos FROM cuentas WHERE id_perfil = ?').bind(perfil.id).first(),
    solicitudesDe(env, perfil.id)
  ]);
  return {
    ok: true, activo: true, conectado: true, perfil, amigos, solicitudes,
    cuenta: cuenta ? { usuario: cuenta.usuario, correo: cuenta.correo || '', avisar: !!cuenta.avisar, aceptoDatos: !!cuenta.acepto_datos } : null
  };
}

/** Nombre de quien invita, para la pantalla de invitación. Va por POST (el código no queda en URLs) y gasta cupo. */
async function verInvitacion(request, env) {
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  const c = String((await leerCuerpo(request)).codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const f = c && await env.DB.prepare('SELECT nombre FROM perfiles WHERE codigo = ?').bind(c).first();
  return f ? { ok: true, nombre: f.nombre } : { ok: false, mensaje: 'Esa invitación no existe o ya no sirve.' };
}

async function guardarPerfil(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Tu sesión se cerró. Entra otra vez.' };
  const cuerpo = await leerCuerpo(request);
  const nombre = limpiarTexto(cuerpo.nombre, 30);
  if (nombre.length < 2) return { ok: false, mensaje: 'Escribe cómo quieres que te vean tus amigos (mínimo 2 letras).' };
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;

  const existe = await perfilDe(env, usuario.id);
  if (existe) {
    await env.DB.prepare('UPDATE perfiles SET nombre = ? WHERE id = ?').bind(nombre, usuario.id).run();
  } else {
    for (let intento = 0; intento < 5; intento++) {
      const r = await env.DB.prepare('INSERT OR IGNORE INTO perfiles (id, nombre, color, codigo, creado) VALUES (?, ?, ?, ?, ?)')
        .bind(usuario.id, nombre, 'dorado', nuevoCodigo(), ahora()).run();
      if (r.meta.changes) break;
      if (await perfilDe(env, usuario.id)) break;    // otro clic simultáneo ya lo creó
    }
  }
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ok: false, mensaje: 'No pudimos crear tu perfil. Intenta de nuevo.' };
  return { ok: true, perfil };
}

async function agregarAmigo(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Entra a tu cuenta para aceptar la invitación.' };
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ok: false, sinPerfil: true, mensaje: 'Primero elige tu nombre.' };
  // El cupo se gasta ANTES de consultar el código: así no sirve para probar códigos al azar.
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  if (!(await cuota(env, 'canje:' + perfil.id, CANJES_POR_DIA))) return { ok: false, mensaje: 'Aceptaste muchas invitaciones hoy. Vuelve mañana.' };
  const cuerpo = await leerCuerpo(request);
  const codigo = String(cuerpo.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const otro = codigo && await env.DB.prepare('SELECT * FROM perfiles WHERE codigo = ?').bind(codigo).first();
  if (!otro) return { ok: false, mensaje: 'Esa invitación no existe o ya no sirve.' };
  if (otro.id === perfil.id) return { ok: false, propia: true, mensaje: 'Esa es tu propia invitación. Mándasela a un amigo.' };
  const r = await hacerAmigos(env, perfil.id, otro.id);
  if (!r.ok) return r;
  return { ok: true, nuevo: r.nuevo, amigo: { id: otro.id, nombre: otro.nombre } };
}

// ---------- Solicitudes de amistad por @usuario ----------
// Buscar el @ no basta para ser amigos: la otra persona tiene que aceptar, porque los amigos ven tu diario.

async function solicitudesDe(env, idPerfil) {
  const [rec, env2] = await env.DB.batch([
    env.DB.prepare('SELECT p.id, p.nombre, p.avatar, c.usuario, s.fecha FROM solicitudes s JOIN perfiles p ON p.id = s.de LEFT JOIN cuentas c ON c.id_perfil = p.id WHERE s.para = ? ORDER BY s.fecha DESC LIMIT 50').bind(idPerfil),
    env.DB.prepare('SELECT para FROM solicitudes WHERE de = ? LIMIT 200').bind(idPerfil)
  ]);
  return {
    recibidas: rec.results.map((f) => ({ id: f.id, nombre: f.nombre, usuario: f.usuario || null, avatar: leerAvatar(f.avatar), fecha: f.fecha })),
    enviadas: env2.results.map((f) => f.para)
  };
}

async function buscarAmigo(request, env, url) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Entra a tu cuenta para buscar amigos.' };
  const q = limpiarUsuario(url.searchParams.get('u')).replace(/[^a-z0-9._]/g, '').slice(0, 20);
  if (q.length < 3) return { ok: true, resultados: [] };
  if (!(await cuota(env, 'buscar:' + usuario.id, BUSQUEDAS_POR_DIA))) return { ok: false, mensaje: 'Hiciste muchas búsquedas hoy. Vuelve mañana.' };
  const filas = await env.DB.prepare(
    'SELECT p.id, p.nombre, p.avatar, c.usuario, ' +
    '(SELECT 1 FROM amistades WHERE a = ?1 AND b = p.id) AS amigo, ' +
    '(SELECT 1 FROM solicitudes WHERE de = ?1 AND para = p.id) AS enviada, ' +
    '(SELECT 1 FROM solicitudes WHERE de = p.id AND para = ?1) AS recibida ' +
    'FROM cuentas c JOIN perfiles p ON p.id = c.id_perfil WHERE c.usuario >= ?2 AND c.usuario < ?3 ORDER BY (c.usuario = ?2) DESC, c.usuario LIMIT 6'
  ).bind(usuario.id, q, q + '\uffff').all();
  return { ok: true, resultados: filas.results.map((f) => ({
    id: f.id, nombre: f.nombre, usuario: f.usuario, avatar: leerAvatar(f.avatar),
    estado: f.id === usuario.id ? 'tu' : f.amigo ? 'amigo' : f.recibida ? 'recibida' : f.enviada ? 'enviada' : 'nuevo'
  })) };
}

/** Crea la amistad en los dos sentidos, si ninguno de los dos llegó al tope de amigos. */
async function hacerAmigos(env, x, y) {
  const [cx, cy] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM amistades WHERE a = ?').bind(x),
    env.DB.prepare('SELECT COUNT(*) AS n FROM amistades WHERE a = ?').bind(y)
  ]);
  if (cx.results[0].n >= MAX_AMIGOS) return { ok: false, mensaje: 'Ya tienes muchísimos amigos en la app.' };
  if (cy.results[0].n >= MAX_AMIGOS) return { ok: false, mensaje: 'Esa persona ya tiene muchísimos amigos en la app.' };
  const fecha = ahora();
  const [r] = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO amistades (a, b, fecha) VALUES (?, ?, ?)').bind(x, y, fecha),
    env.DB.prepare('INSERT OR IGNORE INTO amistades (a, b, fecha) VALUES (?, ?, ?)').bind(y, x, fecha),
    env.DB.prepare('DELETE FROM solicitudes WHERE (de = ? AND para = ?) OR (de = ? AND para = ?)').bind(x, y, y, x)
  ]);
  return { ok: true, nuevo: !!r.meta.changes };
}

async function mandarSolicitud(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Entra a tu cuenta para agregar amigos.' };
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ok: false, sinPerfil: true, mensaje: 'Primero elige tu nombre.' };
  const id = limpiarTexto((await leerCuerpo(request)).id, 80);
  const otro = id && id !== perfil.id && await perfilDe(env, id);
  if (!otro) return { ok: false, mensaje: 'No encontramos a esa persona.' };
  if (await env.DB.prepare('SELECT 1 FROM amistades WHERE a = ? AND b = ?').bind(perfil.id, otro.id).first()) return { ok: true, estado: 'amigo' };
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  const cuantos = await env.DB.prepare('SELECT COUNT(*) AS n FROM amistades WHERE a = ?').bind(perfil.id).first();
  if (cuantos && cuantos.n >= MAX_AMIGOS) return { ok: false, mensaje: 'Ya tienes muchísimos amigos en la app.' };
  // Si la otra persona ya te había mandado solicitud, quedan amigos de una.
  if (await env.DB.prepare('SELECT 1 FROM solicitudes WHERE de = ? AND para = ?').bind(otro.id, perfil.id).first()) {
    const r = await hacerAmigos(env, perfil.id, otro.id);
    if (!r.ok) return r;
    return { ok: true, estado: 'amigo', amigo: { id: otro.id, nombre: otro.nombre } };
  }
  const [env1, rec1] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM solicitudes WHERE de = ?').bind(perfil.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM solicitudes WHERE para = ?').bind(otro.id)
  ]);
  if (env1.results[0].n >= 50) return { ok: false, mensaje: 'Tienes muchas solicitudes sin responder. Espera a que te acepten.' };
  if (rec1.results[0].n >= MAX_SOLICITUDES_RECIBIDAS) return { ok: false, mensaje: 'Esa persona tiene muchas solicitudes pendientes. Intenta más tarde.' };
  await env.DB.prepare('INSERT OR IGNORE INTO solicitudes (de, para, fecha) VALUES (?, ?, ?)').bind(perfil.id, otro.id, ahora()).run();
  return { ok: true, estado: 'enviada' };
}

async function responderSolicitud(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Tu sesión se cerró. Entra otra vez.' };
  const cuerpo = await leerCuerpo(request);
  const id = limpiarTexto(cuerpo.id, 80);
  const existe = id && await env.DB.prepare('SELECT 1 FROM solicitudes WHERE de = ? AND para = ?').bind(id, usuario.id).first();
  if (!existe) return { ok: false, mensaje: 'Esa solicitud ya no está.' };
  if (cuerpo.aceptar) {
    const r = await hacerAmigos(env, usuario.id, id);
    if (!r.ok) return r;
    return { ok: true, estado: 'amigo' };
  }
  await env.DB.prepare('DELETE FROM solicitudes WHERE de = ? AND para = ?').bind(id, usuario.id).run();
  return { ok: true, estado: 'rechazada' };
}

async function quitarAmigo(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Tu sesión se cerró. Entra otra vez.' };
  const cuerpo = await leerCuerpo(request);
  const otro = limpiarTexto(cuerpo.idAmigo, 80);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM amistades WHERE a = ? AND b = ?').bind(usuario.id, otro),
    env.DB.prepare('DELETE FROM amistades WHERE a = ? AND b = ?').bind(otro, usuario.id)
  ]);
  return { ok: true };
}

function nuevoCodigo() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALFABETO_CODIGO[b % ALFABETO_CODIGO.length]).join('');
}

// ====================== CAPTCHA Y TOPE DIARIO ======================

/**
 * Revisa el captcha (si hay secreto configurado) y suma una acción al tope diario de esa conexión.
 * La IP nunca se guarda tal cual: se guarda cifrada (hash) con una sal secreta.
 */
async function controlar(request, env, token, esSitioNuevo, sinCaptcha) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  // Sin IP_SALT no se guarda nada: así nunca queda un hash de IP que se pueda revertir con una sal conocida.
  if (!env.IP_SALT) {
    console.error('Falta el secreto IP_SALT: las acciones que escriben quedan desactivadas.');
    return { ok: false, mensaje: 'La app está en mantenimiento. Intenta en un rato.' };
  }
  const ipHash = await hash(env.IP_SALT + '|' + ip);

  if (!sinCaptcha && env.TURNSTILE_SECRET) {
    if (!token) return { ok: false, captcha: true, mensaje: 'No pudimos comprobar que no eres un robot. Intenta de nuevo.' };
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET);
    form.append('response', String(token));
    if (ip) form.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const v = await r.json().catch(() => ({}));
    if (!v.success) return { ok: false, captcha: true, mensaje: 'No pudimos comprobar que no eres un robot. Recarga la página e intenta de nuevo.' };
  }

  const dia = ahora().slice(0, 10);
  const fila = await env.DB.prepare(
    'INSERT INTO limites (ip_hash, dia, acciones) VALUES (?, ?, 1) ON CONFLICT(ip_hash, dia) DO UPDATE SET acciones = acciones + 1 RETURNING acciones'
  ).bind(ipHash, dia).first();
  if (fila && fila.acciones > ACCIONES_POR_DIA) {
    return { ok: false, mensaje: 'Llegaste al límite de acciones por hoy. Vuelve mañana.' };
  }
  if (esSitioNuevo) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM votos v JOIN lugares l ON l.id = v.id_lugar AND l.creador = v.id_dispositivo WHERE v.ip_hash = ? AND substr(v.fecha, 1, 10) = ?")
      .bind(ipHash, dia).first();
    if (n && n.n >= SITIOS_POR_DIA) return { ok: false, mensaje: 'Ya marcaste muchos sitios hoy. Vuelve mañana para agregar más.' };
  }
  return { ok: true, ipHash };
}

/** Cupo diario con una clave propia (por ejemplo 'buscar:<perfil>'). Comparte la tabla limites. */
async function cuota(env, clave, max) {
  const fila = await env.DB.prepare(
    'INSERT INTO limites (ip_hash, dia, acciones) VALUES (?, ?, 1) ON CONFLICT(ip_hash, dia) DO UPDATE SET acciones = acciones + 1 RETURNING acciones'
  ).bind('cupo|' + clave, ahora().slice(0, 10)).first();
  return !fila || fila.acciones <= max;
}

// ====================== AYUDANTES ======================

function json(datos, estado = 200) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' }
  });
}

async function leerCuerpo(request) {
  try { return await request.json(); } catch { return {}; }
}

async function hash(texto) {
  const datos = new TextEncoder().encode(texto);
  const resumen = await crypto.subtle.digest('SHA-256', datos);
  return Array.from(new Uint8Array(resumen)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fecha y hora de Bogotá en formato ISO, por ejemplo 2026-11-14T16:30:00-05:00. */
function ahora() {
  const d = new Date(Date.now() - 5 * 3600000);
  return d.toISOString().slice(0, 19) + '-05:00';
}
function diasAtras(n) {
  return new Date(Date.now() - 5 * 3600000 - n * 86400000).toISOString().slice(0, 10);
}

function limpiarTexto(valor, max) {
  return String(valor == null ? '' : valor)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** null = vacío (válido), undefined = inválido, número = válido. */
function normalizarPrecio(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const digitos = String(valor).replace(/[^\d]/g, '');
  if (!digitos) return undefined;
  const n = Number(digitos);
  if (n < PRECIO_MIN || n > PRECIO_MAX) return undefined;
  return n;
}

function dispositivoValido(id) { return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id); }

function dentroDeBogota(lat, lng) {
  const L = LIMITES_BOGOTA;
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= L.latMin && lat <= L.latMax && lng >= L.lngMin && lng <= L.lngMax;
}

function redondear(n) { return Math.round(n * 1e6) / 1e6; }

function distanciaMetros(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
