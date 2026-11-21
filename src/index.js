/**
 * ¿Dónde está el mejor buñuelo de Bogotá? — servidor en Cloudflare Workers.
 * La página (public/index.html) se sirve sola como archivo estático.
 * Este código solo atiende las rutas /api/… y guarda todo en la base D1 (binding DB).
 *
 * Variables (wrangler.jsonc → vars):  MAPTILER_KEY, TURNSTILE_SITE_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
 * Secretos (panel de Cloudflare → Settings → Variables and Secrets):  TURNSTILE_SECRET, IP_SALT
 * Si TURNSTILE_SECRET no está puesto, la app funciona sin captcha (útil para probar).
 * Si SUPABASE_URL no está puesto, la app funciona sin amigos (nadie ve el botón de entrar).
 */

const PLATO = 'buñuelo';
const DISTANCIA_DUPLICADO_M = 60;
const LIMITES_BOGOTA = { latMin: 4.44, latMax: 4.84, lngMin: -74.23, lngMax: -73.98 };
const PRECIO_MIN = 100;
const PRECIO_MAX = 50000;
const CAL_MAX = 5;
const ACCIONES_POR_DIA = 80;      // votos + sitios + calificaciones por conexión (IP) al día
const SITIOS_POR_DIA = 10;        // sitios nuevos por conexión al día
const MAX_AMIGOS = 200;
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin 0/O ni 1/I para no confundir

export default {
  // Cron del 31 de diciembre: manda el correo del resumen (ver wrangler.jsonc → triggers)
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(mandarCorreosResumen(env));
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
        case 'GET /api/diario': return json(await diario(request, env, url));
        case 'POST /api/anotar': return json(await anotar(request, env));
        case 'POST /api/entrada/borrar': return json(await borrarEntrada(request, env));
        case 'POST /api/por-probar': return json(await porProbar(request, env));
        case 'POST /api/seguir': return json(await seguirLista(request, env));
        case 'POST /api/provocar': return json(await provocar(request, env));
        case 'GET /api/actividad': return json(await actividad(request, env));
        case 'GET /api/yo': return json(await yo(request, env, url));
        case 'POST /api/registro': return json(await registrar(request, env));
        case 'POST /api/entrar': return json(await entrar(request, env));
        case 'POST /api/salir': return json(await salirCuenta(request, env));
        case 'POST /api/cuenta': return json(await actualizarCuenta(request, env));
        case 'POST /api/cuatro': return json(await guardarCuatro(request, env));
        case 'POST /api/avatar': return json(await guardarAvatar(request, env));
        case 'GET /api/perfil-amigo': return json(await perfilAmigo(request, env, url));
        case 'GET /api/invitacion': return json(await verInvitacion(env, url.searchParams.get('codigo')));
        case 'POST /api/perfil': return json(await guardarPerfil(request, env));
        case 'POST /api/amigos': return json(await agregarAmigo(request, env));
        case 'POST /api/amigos/quitar': return json(await quitarAmigo(request, env));
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
    // La llave "anon" de Supabase es pública por diseño: sirve solo para abrir la puerta de entrar con Google.
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    resumenDesde: /^\d{4}-\d{2}-\d{2}$/.test(env.RESUMEN_DESDE || '') ? env.RESUMEN_DESDE : '2026-12-31'
  };
}

// ====================== LECTURA ======================

async function obtenerLugares(env, plato) {
  // nota = promedio de la última calificación de cada teléfono
  const { results } = await env.DB.prepare(
    "SELECT l.id, l.nombre, l.lat, l.lng, l.barrio, l.precio, l.creado, l.votos, l.probados, n.nota FROM lugares l " +
    "LEFT JOIN (SELECT id_lugar, ROUND(AVG(cal), 1) AS nota FROM entradas e WHERE creado = (SELECT MAX(creado) FROM entradas x WHERE x.id_lugar = e.id_lugar AND x.id_dispositivo = e.id_dispositivo) GROUP BY id_lugar) n ON n.id_lugar = l.id " +
    "WHERE l.plato = ? AND l.estado = 'visible'"
  ).bind(plato).all();
  return results.map(aLugar);
}

async function obtenerListas(env) {
  const { results } = await env.DB.prepare('SELECT * FROM listas ORDER BY orden').all();
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
    nota: f.nota === null || f.nota === undefined ? null : Number(f.nota)
  };
}

async function lugarPorId(env, id) {
  const f = await env.DB.prepare(
    "SELECT id, nombre, lat, lng, barrio, precio, creado, votos, probados, " +
    "(SELECT ROUND(AVG(cal), 1) FROM entradas e WHERE e.id_lugar = lugares.id AND e.creado = (SELECT MAX(creado) FROM entradas x WHERE x.id_lugar = e.id_lugar AND x.id_dispositivo = e.id_dispositivo)) AS nota " +
    "FROM lugares WHERE id = ? AND estado = 'visible'"
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

  const control = await controlar(request, env, cuerpo.token, false);
  if (!control.ok) return control;

  const lugar = await lugarPorId(env, idLugar);
  if (!lugar) return { ok: false, mensaje: 'Ese sitio ya no está en el mapa.' };

  // Con cuenta: un voto por persona y por sitio, sin importar desde cuántos teléfonos entre.
  const { ids, perfil } = await dispositivosDe(request, env, idDispositivo);
  const yaVoto = perfil
    ? await env.DB.prepare('SELECT 1 FROM votos WHERE id_lugar = ? AND (id_perfil = ? OR id_dispositivo IN (' + marcas(ids.length) + ')) LIMIT 1').bind(idLugar, perfil.id, ...ids).first()
    : null;
  if (yaVoto) return { ok: false, yaVoto: true, lugar, mensaje: 'Ya votaste por este sitio.' };

  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO votos (id_lugar, plato, fecha, id_dispositivo, ip_hash, id_perfil) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(idLugar, PLATO, ahora(), idDispositivo, control.ipHash, perfil ? perfil.id : null).run();

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

  const control = await controlar(request, env, cuerpo.token, true);
  if (!control.ok) return control;

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
      'INSERT INTO votos (id_lugar, plato, fecha, id_dispositivo, ip_hash) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, PLATO, fecha, idDispositivo, control.ipHash)
  ]);

  return {
    ok: true,
    lugar: { id, nombre, lat, lng, barrio, precio, creado: Date.parse(fecha), votos: 1, probados: 0 }
  };
}

// ====================== DIARIO ======================
// Cada vez que alguien come en un sitio queda una entrada con fecha, puntaje (de media en media),
// "¿volverías?" y una reseña opcional. Sin cuenta, el diario es del teléfono. Con cuenta, junta todos sus teléfonos.

const RESENA_MAX = 500;

/** Teléfonos cuyo diario puede ver y tocar quien hace la petición. */
async function dispositivosDe(request, env, idDispositivo) {
  const propios = dispositivoValido(idDispositivo) ? [idDispositivo] : [];
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ids: propios, perfil: null };
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ids: propios, perfil: null };
  if (propios.length) await unirDispositivo(env, perfil.id, idDispositivo);
  const { results } = await env.DB.prepare('SELECT id_dispositivo FROM perfil_dispositivos WHERE id_perfil = ?').bind(perfil.id).all();
  const ids = new Set(propios);
  results.forEach((f) => ids.add(f.id_dispositivo));
  return { ids: Array.from(ids).slice(0, 20), perfil };
}
const marcas = (n) => new Array(n).fill('?').join(',');

function aEntrada(f) {
  return {
    id: f.id, idLugar: f.id_lugar, fecha: f.fecha, cal: Number(f.cal),
    volveria: f.volveria === null || f.volveria === undefined ? null : !!f.volveria,
    resena: f.resena || '', creado: Date.parse(f.creado) || 0, provocas: Number(f.provocas) || 0
  };
}

async function diario(request, env, url) {
  const { ids, perfil } = await dispositivosDe(request, env, url.searchParams.get('d'));
  if (!ids.length) return { ok: false, mensaje: 'No pudimos identificar tu dispositivo. Recarga la página.' };
  const q = marcas(ids.length);
  const [e, p, s] = await env.DB.batch([
    env.DB.prepare('SELECT e.*, (SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id) AS provocas FROM entradas e WHERE id_dispositivo IN (' + q + ') ORDER BY fecha DESC, creado DESC LIMIT 1000').bind(...ids),
    env.DB.prepare('SELECT id_lugar, MAX(fecha) AS fecha FROM por_probar WHERE id_dispositivo IN (' + q + ') GROUP BY id_lugar ORDER BY fecha DESC').bind(...ids),
    env.DB.prepare('SELECT DISTINCT id_lista FROM seguimientos WHERE id_dispositivo IN (' + q + ')').bind(...ids)
  ]);
  const v = await env.DB.prepare('SELECT DISTINCT id_lugar FROM votos WHERE id_dispositivo IN (' + q + ')' + (perfil ? ' OR id_perfil = ?' : ''))
    .bind(...ids, ...(perfil ? [perfil.id] : [])).all();
  return {
    ok: true,
    votados: v.results.map((f) => f.id_lugar),
    cuatro: perfil ? leerCuatro(perfil.cuatro) : null,
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

  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  const lugar = await lugarPorId(env, idLugar);
  if (!lugar) return { ok: false, mensaje: 'Ese sitio ya no está en el mapa.' };

  // Editar una entrada que ya existe
  if (cuerpo.id) {
    const { ids } = await dispositivosDe(request, env, idDispositivo);
    const id = limpiarTexto(cuerpo.id, 40);
    const r = await env.DB.prepare('UPDATE entradas SET fecha = ?, cal = ?, volveria = ?, resena = ? WHERE id = ? AND id_lugar = ? AND id_dispositivo IN (' + marcas(ids.length) + ')')
      .bind(fecha, cal, volveria, resena || null, id, idLugar, ...ids).run();
    if (!r.meta.changes) return { ok: false, mensaje: 'No encontramos esa anotación.' };
    const f = await env.DB.prepare('SELECT e.*, (SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id) AS provocas FROM entradas e WHERE id = ?').bind(id).first();
    return { ok: true, nueva: false, entrada: aEntrada(f), lugar: await lugarPorId(env, idLugar) };
  }

  const yaHabia = await env.DB.prepare('SELECT 1 FROM entradas WHERE id_lugar = ? AND id_dispositivo = ? LIMIT 1').bind(idLugar, idDispositivo).first();
  const id = 'E-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const creado = ahora();
  const ops = [
    env.DB.prepare('INSERT INTO entradas (id, id_lugar, plato, id_dispositivo, fecha, cal, volveria, resena, creado, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, idLugar, PLATO, idDispositivo, fecha, cal, volveria, resena || null, creado, control.ipHash),
    // Si estaba en "Por probar", ya no
    env.DB.prepare('DELETE FROM por_probar WHERE id_dispositivo = ? AND id_lugar = ?').bind(idDispositivo, idLugar)
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
  const { ids } = await dispositivosDe(request, env, cuerpo.idDispositivo);
  if (!ids.length) return { ok: false, mensaje: 'No pudimos identificar tu dispositivo.' };
  const id = limpiarTexto(cuerpo.id, 40);
  const f = await env.DB.prepare('SELECT id_lugar, id_dispositivo FROM entradas WHERE id = ? AND id_dispositivo IN (' + marcas(ids.length) + ')').bind(id, ...ids).first();
  if (!f) return { ok: false, mensaje: 'No encontramos esa anotación.' };
  await env.DB.batch([
    env.DB.prepare('DELETE FROM entradas WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM provocas WHERE id_entrada = ?').bind(id)
  ]);
  const quedan = await env.DB.prepare('SELECT 1 FROM entradas WHERE id_lugar = ? AND id_dispositivo = ? LIMIT 1').bind(f.id_lugar, f.id_dispositivo).first();
  if (!quedan) await env.DB.prepare('UPDATE lugares SET probados = MAX(probados - 1, 0) WHERE id = ?').bind(f.id_lugar).run();
  return { ok: true, lugar: await lugarPorId(env, f.id_lugar) };
}

async function porProbar(request, env) {
  const cuerpo = await leerCuerpo(request);
  const idDispositivo = cuerpo.idDispositivo;
  const idLugar = limpiarTexto(cuerpo.idLugar, 40);
  if (!dispositivoValido(idDispositivo)) return { ok: false, mensaje: 'No pudimos identificar tu dispositivo. Recarga la página.' };
  if (cuerpo.quitar) {
    const { ids } = await dispositivosDe(request, env, idDispositivo);
    await env.DB.prepare('DELETE FROM por_probar WHERE id_lugar = ? AND id_dispositivo IN (' + marcas(ids.length) + ')').bind(idLugar, ...ids).run();
    return { ok: true };
  }
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  if (!(await lugarPorId(env, idLugar))) return { ok: false, mensaje: 'Ese sitio ya no está en el mapa.' };
  await env.DB.prepare('INSERT OR IGNORE INTO por_probar (id_dispositivo, id_lugar, plato, fecha) VALUES (?, ?, ?, ?)')
    .bind(idDispositivo, idLugar, PLATO, ahora()).run();
  return { ok: true };
}

async function seguirLista(request, env) {
  const cuerpo = await leerCuerpo(request);
  const idDispositivo = cuerpo.idDispositivo;
  const idLista = limpiarTexto(cuerpo.idLista, 60);
  if (!dispositivoValido(idDispositivo) || !idLista) return { ok: false, mensaje: 'No pudimos guardar eso.' };
  if (cuerpo.quitar) {
    const { ids } = await dispositivosDe(request, env, idDispositivo);
    await env.DB.prepare('DELETE FROM seguimientos WHERE id_lista = ? AND id_dispositivo IN (' + marcas(ids.length) + ')').bind(idLista, ...ids).run();
    return { ok: true };
  }
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  await env.DB.prepare('INSERT OR IGNORE INTO seguimientos (id_dispositivo, id_lista, fecha) VALUES (?, ?, ?)').bind(idDispositivo, idLista, ahora()).run();
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
  const dueno = await env.DB.prepare('SELECT pd.id_perfil FROM entradas e JOIN perfil_dispositivos pd ON pd.id_dispositivo = e.id_dispositivo WHERE e.id = ?').bind(id).first();
  if (!dueno) return { ok: false, mensaje: 'Esa anotación ya no existe.' };
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
      'FROM entradas e JOIN perfil_dispositivos pd ON pd.id_dispositivo = e.id_dispositivo JOIN perfiles pf ON pf.id = pd.id_perfil ' +
      'WHERE (pd.id_perfil = ?1 OR pd.id_perfil IN (SELECT b FROM amistades WHERE a = ?1)) AND e.creado >= ?2 ORDER BY e.creado DESC LIMIT 60'
    ).bind(perfil.id, desde),
    env.DB.prepare(
      'SELECT pp.id_lugar, pp.fecha, pf.id AS id_perfil, pf.nombre, pf.avatar FROM por_probar pp JOIN perfil_dispositivos pd ON pd.id_dispositivo = pp.id_dispositivo JOIN perfiles pf ON pf.id = pd.id_perfil ' +
      'WHERE pd.id_perfil IN (SELECT b FROM amistades WHERE a = ?1) AND pp.fecha >= ?2 ORDER BY pp.fecha DESC LIMIT 30'
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
  return { id: f.id_perfil, nombreGoogle: '' };
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

  const control = await controlar(request, env, null, false, true);
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
      env.DB.prepare('INSERT INTO cuentas (id_perfil, usuario, clave_hash, sal, correo, avisar, creado) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(idPerfil, usuario, await huellaClave(clave, sal), sal, correo || null, correo && cuerpo.avisar ? 1 : 0, creado)
    ]);
  } catch (e) {
    return { ok: false, campo: 'usuario', mensaje: 'Ese usuario ya existe. Prueba con otro.' };
  }
  await unirDispositivo(env, idPerfil, cuerpo.idDispositivo);
  return { ok: true, token: await nuevaSesion(env, idPerfil), perfil: await perfilDe(env, idPerfil) };
}

async function entrar(request, env) {
  const cuerpo = await leerCuerpo(request);
  const usuario = limpiarUsuario(cuerpo.usuario);
  const clave = String(cuerpo.clave || '').slice(0, 200);
  if (!usuario || !clave) return { ok: false, mensaje: 'Escribe tu usuario y tu contraseña.' };
  // cada intento cuenta para el tope diario: así nadie puede adivinar contraseñas a la fuerza
  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  const c = await env.DB.prepare('SELECT id_perfil, clave_hash, sal FROM cuentas WHERE usuario = ?').bind(usuario).first();
  const huella = await huellaClave(clave, c ? c.sal : 'sin-cuenta');
  if (!c || !igualesSeguro(huella, c.clave_hash)) return { ok: false, mensaje: 'El usuario o la contraseña no coinciden.' };
  await unirDispositivo(env, c.id_perfil, cuerpo.idDispositivo);
  return { ok: true, token: await nuevaSesion(env, c.id_perfil), perfil: await perfilDe(env, c.id_perfil) };
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
  const [e, p, n] = await env.DB.batch([
    env.DB.prepare(
      'SELECT e.*, (SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id) AS provocas, ' +
      '(SELECT COUNT(*) FROM provocas v WHERE v.id_entrada = e.id AND v.id_perfil = ?) AS mio ' +
      'FROM entradas e JOIN perfil_dispositivos pd ON pd.id_dispositivo = e.id_dispositivo WHERE pd.id_perfil = ? ORDER BY e.fecha DESC, e.creado DESC LIMIT 500'
    ).bind(usuario.id, idAmigo),
    env.DB.prepare('SELECT pp.id_lugar, MAX(pp.fecha) AS fecha FROM por_probar pp JOIN perfil_dispositivos pd ON pd.id_dispositivo = pp.id_dispositivo WHERE pd.id_perfil = ? GROUP BY pp.id_lugar ORDER BY fecha DESC').bind(idAmigo),
    env.DB.prepare('SELECT COUNT(*) AS n FROM amistades WHERE a = ?').bind(idAmigo)
  ]);
  return {
    ok: true,
    perfil: { id: amigo.id, nombre: amigo.nombre, avatar: leerAvatar(amigo.avatar), cuatro: leerCuatro(amigo.cuatro), amigos: n.results[0].n },
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
  // Solo desde el día del resumen y desde las 9 a. m. de Bogotá
  const hoy = ahora();
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(env.RESUMEN_DESDE || '') ? env.RESUMEN_DESDE : '2026-12-31';
  if (hoy.slice(0, 10) < desde || Number(hoy.slice(11, 13)) < 9) return 0;
  const { results } = await env.DB.prepare(
    'SELECT c.id_perfil, c.correo, p.nombre, ' +
    '(SELECT COUNT(DISTINCT e.id_lugar) FROM entradas e JOIN perfil_dispositivos pd ON pd.id_dispositivo = e.id_dispositivo WHERE pd.id_perfil = c.id_perfil) AS sitios ' +
    'FROM cuentas c JOIN perfiles p ON p.id = c.id_perfil WHERE c.avisar = 1 AND c.correo IS NOT NULL AND c.avisado IS NULL LIMIT 40'
  ).all();
  let enviados = 0;
  for (const f of results) {
    if (!f.sitios) {   // sin anotaciones no hay resumen que mandar
      await env.DB.prepare('UPDATE cuentas SET avisado = ? WHERE id_perfil = ?').bind('sin-datos', f.id_perfil).run();
      continue;
    }
    const enlace = env.URL_APP.replace(/\/$/, '') + '/?resumen=1';
    const texto = 'Hola, ' + f.nombre + '. Este diciembre anotaste ' + f.sitios + (f.sitios === 1 ? ' buñuelo' : ' buñuelos') + ' en Apetitosos. Tu resumen ya está listo: ' + enlace;
    const html = '<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#312A20">' +
      '<p>Hola, ' + escaparHtml(f.nombre) + '.</p><p>Este diciembre anotaste ' + f.sitios + (f.sitios === 1 ? ' buñuelo' : ' buñuelos') + ' en Apetitosos. Tu resumen ya está listo.</p>' +
      '<p><a href="' + enlace + '" style="display:inline-block;padding:14px 22px;border-radius:28px;background:#F2C230;color:#312A20;font-weight:bold;text-decoration:none">Ver mi resumen buñuelero</a></p></div>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.CORREO_DESDE, to: [f.correo], subject: 'Tu temporada en buñuelos ya está servida', text: texto, html })
    });
    if (r.ok) {
      await env.DB.prepare('UPDATE cuentas SET avisado = ? WHERE id_perfil = ?').bind(ahora(), f.id_perfil).run();
      enviados++;
    }
  }
  return enviados;
}
function escaparHtml(t) { return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ====================== CUENTAS Y AMIGOS ======================
// Supabase solo se usa para "Entrar con Google". Los perfiles y las amistades viven aquí, en D1.
// Del usuario de Google se guarda únicamente su número interno (id). El correo no se guarda.

const sesiones = new Map();   // memoria corta: token → { usuario, vence }

async function usuarioDe(request, env) {
  const cabecera = request.headers.get('Authorization') || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';
  if (!token || token.length > 4096) return null;
  if (token.startsWith(PREFIJO_SESION)) return usuarioDeSesionPropia(env, token);
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const guardado = sesiones.get(token);
  if (guardado && guardado.vence > Date.now()) return guardado.usuario;
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.id) return null;
  const meta = u.user_metadata || {};
  const usuario = { id: 'g-' + u.id, nombreGoogle: String(meta.full_name || meta.name || '').split(' ')[0] };
  if (sesiones.size > 500) sesiones.clear();
  sesiones.set(token, { usuario, vence: Date.now() + 5 * 60000 });
  return usuario;
}

function aPerfil(f) { return f ? { id: f.id, nombre: f.nombre, color: f.color, codigo: f.codigo, cuatro: f.cuatro || null, avatar: leerAvatar(f.avatar) } : null; }

// Avatar: personaje + gesto + color del círculo + frase corta. Se guarda como JSON en perfiles.avatar.
const PERSONAJES = ['oso', 'zorro', 'perro', 'coneja', 'gata'];
const FONDOS = ['mostaza', 'salvia', 'naranja', 'arena', 'rojo'];
function leerAvatar(t) {
  let a = t;
  if (typeof t === 'string') { try { a = JSON.parse(t); } catch (e) { return null; } }
  if (!a || typeof a !== 'object' || !PERSONAJES.includes(a.p)) return null;
  return {
    p: a.p,
    g: a.g === 1 ? 1 : 0,
    f: FONDOS.includes(a.f) ? a.f : 'mostaza',
    frase: limpiarTexto(a.frase, 60)
  };
}
function leerCuatro(t) { try { const a = JSON.parse(t || 'null'); return Array.isArray(a) && a.length === 4 ? a.map((x) => (typeof x === 'string' ? x.slice(0, 40) : null)) : null; } catch (e) { return null; } }

async function perfilDe(env, idUsuario) {
  return aPerfil(await env.DB.prepare('SELECT * FROM perfiles WHERE id = ?').bind(idUsuario).first());
}

/** Este teléfono queda unido a la cuenta: así sus "probados" cuentan para los amigos. */
async function unirDispositivo(env, idPerfil, idDispositivo) {
  if (!dispositivoValido(idDispositivo)) return;
  await env.DB.prepare(
    'INSERT INTO perfil_dispositivos (id_dispositivo, id_perfil, fecha) VALUES (?, ?, ?) ' +
    'ON CONFLICT(id_dispositivo) DO UPDATE SET id_perfil = excluded.id_perfil, fecha = excluded.fecha WHERE id_perfil != excluded.id_perfil'
  ).bind(idDispositivo, idPerfil, ahora()).run();
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
    env.DB.prepare('SELECT p.id, p.nombre, p.color, p.avatar, a.fecha FROM amistades a JOIN perfiles p ON p.id = a.b WHERE a.a = ? ORDER BY p.nombre').bind(idPerfil),
    env.DB.prepare(
      'SELECT pd.id_perfil, e.id_lugar, e.cal AS calificacion, e.creado AS fecha FROM amistades a ' +
      'JOIN perfil_dispositivos pd ON pd.id_perfil = a.b JOIN entradas e ON e.id_dispositivo = pd.id_dispositivo WHERE a.a = ?'
    ).bind(idPerfil)
  ]);
  const porPerfil = agruparProbados(prob.results);
  return lista.results.map((f) => ({ id: f.id, nombre: f.nombre, color: f.color, avatar: leerAvatar(f.avatar), desde: Date.parse(f.fecha) || 0, probados: porPerfil[f.id] || {} }));
}

async function yo(request, env, url) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: true, activo: true, conectado: false };
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ok: true, activo: true, conectado: true, perfil: null, nombreSugerido: usuario.nombreGoogle };
  await unirDispositivo(env, perfil.id, url.searchParams.get('d'));
  const [amigos, cuenta] = await Promise.all([
    amigosDe(env, perfil.id),
    env.DB.prepare('SELECT usuario, correo, avisar FROM cuentas WHERE id_perfil = ?').bind(perfil.id).first()
  ]);
  return {
    ok: true, activo: true, conectado: true, perfil, amigos,
    cuenta: cuenta ? { usuario: cuenta.usuario, correo: cuenta.correo || '', avisar: !!cuenta.avisar } : null
  };
}

async function verInvitacion(env, codigo) {
  const c = String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!c) return { ok: false };
  const f = await env.DB.prepare('SELECT nombre FROM perfiles WHERE codigo = ?').bind(c).first();
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
  await unirDispositivo(env, perfil.id, cuerpo.idDispositivo);
  return { ok: true, perfil };
}

async function agregarAmigo(request, env) {
  const usuario = await usuarioDe(request, env);
  if (!usuario) return { ok: false, sesion: true, mensaje: 'Entra a tu cuenta para aceptar la invitación.' };
  const perfil = await perfilDe(env, usuario.id);
  if (!perfil) return { ok: false, sinPerfil: true, mensaje: 'Primero elige tu nombre.' };
  const cuerpo = await leerCuerpo(request);
  const codigo = String(cuerpo.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  const otro = codigo && await env.DB.prepare('SELECT * FROM perfiles WHERE codigo = ?').bind(codigo).first();
  if (!otro) return { ok: false, mensaje: 'Esa invitación no existe o ya no sirve.' };
  if (otro.id === perfil.id) return { ok: false, propia: true, mensaje: 'Esa es tu propia invitación. Mándasela a un amigo.' };

  const control = await controlar(request, env, null, false, true);
  if (!control.ok) return control;
  const cuantos = await env.DB.prepare('SELECT COUNT(*) AS n FROM amistades WHERE a = ?').bind(perfil.id).first();
  if (cuantos && cuantos.n >= MAX_AMIGOS) return { ok: false, mensaje: 'Ya tienes muchísimos amigos en la app.' };

  const fecha = ahora();
  const [r] = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO amistades (a, b, fecha) VALUES (?, ?, ?)').bind(perfil.id, otro.id, fecha),
    env.DB.prepare('INSERT OR IGNORE INTO amistades (a, b, fecha) VALUES (?, ?, ?)').bind(otro.id, perfil.id, fecha)
  ]);
  return { ok: true, nuevo: !!r.meta.changes, amigo: { id: otro.id, nombre: otro.nombre } };
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
  const ipHash = await hash((env.IP_SALT || 'sal-provisional') + '|' + ip);

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
  // De vez en cuando se borran los conteos viejos.
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM limites WHERE dia < ?').bind(diasAtras(3)).run();
  }
  return { ok: true, ipHash };
}

// ====================== AYUDANTES ======================

function json(datos, estado = 200) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function leerCuerpo(request) {
  try { return await request.json(); } catch (e) { return {}; }
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
