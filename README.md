# Apetitosos · ¿Dónde está el mejor buñuelo de Bogotá?

Web app móvil para votar, calificar y llevar un diario de los buñuelos de Bogotá en temporada de diciembre, con amigos, como en Letterboxd o Beli. Es la primera temporada de **Apetitosos**: después vendrán otros platos.

- **Producción:** Cloudflare Workers (worker `apetitosos`), publicado automáticamente desde este repositorio (Workers Builds, rama `main`).
- **Base de datos:** Cloudflare D1 (SQLite), base `buena-muela`.
- **Sin framework ni paso de compilación.** El servidor es un solo archivo JavaScript (ES modules). La página es un HTML con su CSS y su JS en archivos aparte.
- **Auditoría de seguridad:** el informe de TI del 24 de noviembre de 2026 y lo que se hizo con cada punto están en [`docs/RESPUESTA-AUDITORIA.md`](docs/RESPUESTA-AUDITORIA.md).
- **Revisión UX:** lo que se hizo con cada comentario de diseño de experiencias está en [`docs/RESPUESTA-UX.md`](docs/RESPUESTA-UX.md).

---

## Estructura

```
public/
  index.html        Estructura de la página.
  app.js            Lógica del cliente (sin dependencias de npm).
  app.css           Estilos.
  img/              Ilustraciones (webp). av-* son los avatares, oso-* el personaje, og-* el oso del registro.
  _headers          Cabeceras de seguridad y CSP de los archivos estáticos.
src/
  index.js          Worker: atiende /api/* y los crons (limpieza diaria y correo del 31 de diciembre).
base/
  esquema.sql       Esquema completo de D1, idempotente.
  migraciones/      Cambios de esquema ya aplicados en producción, en orden de fecha.
docs/
  RESPUESTA-AUDITORIA.md   Qué se hizo con cada punto del informe de seguridad.
  RESPUESTA-UX.md          Qué se hizo con cada comentario de la revisión UX.
wrangler.jsonc      Configuración del Worker, la base y las variables públicas.
.dev.vars.example   Plantilla de secretos para desarrollo local.
```

Cómo fluye una petición: Cloudflare sirve `public/` directamente. Solo las rutas `/api/*` llegan al Worker (`run_worker_first`), que responde JSON y lee y escribe en D1.

## Correr en local

Necesitas Node 20 o más.

```bash
npm ci
cp .dev.vars.example .dev.vars          # sin IP_SALT, todo lo que escribe responde "en mantenimiento"
npm run db:local          # crea las tablas en una base local (.wrangler/)
npm run dev               # http://localhost:8787
```

La base local empieza vacía. Para tener sitios, agrégalos tocando el mapa en la app o con `INSERT` en `lugares`.

## Publicar

Cada push a `main` publica solo (Cloudflare → Workers → apetitosos → Deployments). A mano: `npm run deploy`. `wrangler` está fijado a una versión exacta en `package.json`. En Workers Builds conviene que el comando de instalación sea `npm ci`.

Los cambios de esquema **no** se aplican solos. Cada cambio va como archivo en `base/migraciones/`, se corre una vez contra producción **antes** de publicar el código que lo usa, y se refleja en `base/esquema.sql`:

```bash
npx wrangler d1 export DB --remote --output respaldo-AAAA-MM-DD.sql     # respaldo primero
npx wrangler d1 execute DB --remote --file base/migraciones/AAAA-MM-DD-nombre.sql
```

## Configuración

| Nombre | Tipo | Para qué | Si falta |
| --- | --- | --- | --- |
| `MAPTILER_KEY` | var pública | Mapa (MapTiler). Restringir por dominio en el panel de MapTiler. | No carga el mapa |
| `TURNSTILE_SITE_KEY` | var pública | Captcha de Cloudflare Turnstile en el navegador. Con ella, el script de Turnstile se carga solo cuando hace falta | Sin captcha y sin cargar el script |
| `URL_APP` | var pública | Enlace en el correo del resumen | No se mandan correos |
| `CORREO_DESDE` | var pública | Remitente del correo, p. ej. `Apetitosos <hola@dominio.co>` | No se mandan correos |
| `RESUMEN_DESDE` | var pública (opcional) | Fecha `AAAA-MM-DD` en que abre el resumen anual | `2026-12-31` |
| `ALIADO_NOMBRE`, `ALIADO_LOGO`, `ALIADO_URL` | var pública | Aliado comercial: "Con el apoyo de" en la bienvenida, el banner, el mapa y el pie. El logo de Alpina ya está en `public/img/aliados/alpina.webp` | No aparece ningún aliado |
| `URL_POLITICA_DATOS`, `URL_TERMINOS`, `URL_CONTACTO` | var pública | Enlaces del pie de página y de la casilla de autorización del registro | Las páginas vigentes de elespectador.com |
| `IP_SALT` | **secreto** | Sal para el hash de las IP (límites anti-abuso) | **Todo lo que escribe se apaga** ("en mantenimiento") y queda un error en los registros |
| `TURNSTILE_SECRET` | **secreto** | Verificación del captcha en el servidor | Sin captcha |
| `RESEND_API_KEY` | **secreto** | Envío del correo del resumen (Resend) | No se mandan correos |

Los secretos se ponen con `npx wrangler secret put NOMBRE` o en el panel (Worker → Settings → Variables and Secrets). Nunca van en `wrangler.jsonc`.

**Estado actual en producción:** `IP_SALT` puesto. Turnstile y el correo están apagados: faltan las claves, el dominio propio y la cuenta de Resend.

## Servicios externos que carga la página

| Servicio | Para qué | Notas |
| --- | --- | --- |
| `cdn.maptiler.com` (MapTiler SDK v4.1.0, versión fija) | Mapa | Usa la llave pública `MAPTILER_KEY` |
| `challenges.cloudflare.com` | Captcha Turnstile | Solo se descarga si `TURNSTILE_SITE_KEY` está puesta |
| `fonts.googleapis.com` | Tipografías Outfit e IBM Plex Mono | |
| `google.com/maps` | Solo enlaces de "Cómo llegar" | No se carga nada |

El servidor llama a `challenges.cloudflare.com` (verificar captcha) y a `api.resend.com` (correo), cada uno solo si su secreto está puesto.

## Modelo de datos

El detalle de cada columna está en `base/esquema.sql`. En resumen:

- **Sitios y ranking:** `lugares`, `votos` (uno por sitio y persona), `listas` (editoriales) y `seguimientos`.
- **Diario:** `entradas` (cada visita, con fecha, calificación de 0,5 a 5, "¿volverías?" y reseña opcional) y `por_probar`.
- **Ranking (Top 10):** se ordena por un **promedio bayesiano**. Cada calificación cuenta con su nota (la última de cada persona), cada voto cuenta como un 5, y a cada sitio se le suman 3 opiniones con la nota media de la ciudad (`CONFIANZA` en `app.js`). Se calcula en el cliente con `votos`, `nota` y `opiniones` de `/api/lugares`. La app lo explica en "¿Cómo se calcula?".
- **Cuentas y amigos:** `cuentas`, `sesiones`, `perfiles`, `perfil_dispositivos`, `amistades`, `solicitudes` y `provocas` ("me provoca").
- **Anti-abuso:** `limites` (conteo diario por hash de IP y cupos por cuenta. Se purga a los 3 días).

**Identidad.** Todo lo que se escribe (votos, sitios, entradas, Por probar, listas seguidas) exige cuenta y guarda el `id_perfil` de quien lo escribió. Leer el diario también exige cuenta. El `id_dispositivo` (un id al azar en localStorage) ya no da permiso de nada: se guarda en cada fila y sirve solo para pasarle a su dueño lo que anotó sin cuenta antes del 25 de noviembre de 2026, cuando entra desde ese mismo navegador. Un navegador que ya es de una cuenta nunca cambia de dueño: si otra cuenta entra desde él, el navegador estrena un id nuevo.

## API

Todas las rutas responden JSON con `{ ok: true, … }` o `{ ok: false, mensaje }`. Los mensajes de error están en español y se muestran tal cual al usuario. Las rutas con cuenta exigen `Authorization: Bearer bm_…`. Sin token responden `{ ok: false, sesion: true }`.

| Método y ruta | Cuenta | Tope diario | Qué hace |
| --- | --- | --- | --- |
| `GET /api/config` | | | Llaves públicas y fecha del resumen |
| `GET /api/lugares` | | | Sitios visibles con votos y nota promedio |
| `GET /api/listas` | | | Listas publicadas |
| `POST /api/votar` | ✔ | ✔ + captcha | Voto (uno por sitio y persona) |
| `POST /api/lugares` | ✔ | ✔ + captcha | Sitio nuevo (máx. 10 por conexión y 10 por cuenta al día, sin duplicados a menos de 60 m) |
| `GET /api/diario` | ✔ | | Diario, Por probar, listas seguidas, votos y favoritos de la cuenta |
| `POST /api/anotar` | ✔ | ✔ | Crear o editar una entrada del diario |
| `POST /api/entrada/borrar` | ✔ | | Borrar una entrada propia |
| `POST /api/por-probar` | ✔ | ✔ | Agregar o quitar de Por probar |
| `POST /api/seguir` | ✔ | ✔ | Seguir o dejar de seguir una lista |
| `POST /api/registro` | | ✔ + captcha | Crear cuenta (usuario, contraseña ≥ 8, nombre, correo opcional y `acepta: true`, la autorización de datos) |
| `POST /api/entrar` | | ✔ + captcha | Iniciar sesión. 5 contraseñas malas seguidas bloquean la cuenta 15 minutos |
| `POST /api/salir` | ✔ | | Cerrar sesión (borra el token) |
| `GET /api/yo` | | | Perfil, amigos, solicitudes y cuenta. Sin token: `conectado: false` |
| `POST /api/cuenta` | ✔ | | Cambiar nombre, correo y aviso por correo |
| `POST /api/perfil` | ✔ | ✔ | Crear o renombrar el perfil |
| `POST /api/cuatro` | ✔ | | Guardar "Mis favoritos" |
| `POST /api/avatar` | ✔ | | Guardar personaje, gesto, color y frase |
| `POST /api/aceptar-datos` | ✔ | | Autorización de tratamiento de datos para cuentas creadas antes de la casilla |
| `GET /api/actividad` | ✔ | | Anotaciones propias y de amigos de los últimos 60 días |
| `POST /api/provocar` | ✔ | | "Me provoca" a la anotación de un amigo |
| `GET /api/perfil-amigo?id=` | ✔ | | Perfil, diario y favoritos de un amigo (solo amigos) |
| `POST /api/invitacion` | | ✔ | Nombre de quien invita (el código va en el cuerpo, no en la URL) |
| `POST /api/amigos` | ✔ | ✔ + 20 por cuenta | Aceptar un enlace de invitación. El cliente siempre pide confirmación antes |
| `GET /api/buscar-amigo?u=` | ✔ | 200 por cuenta | Buscar personas por prefijo de @usuario (mín. 3 letras, máx. 6 resultados) |
| `POST /api/solicitud` | ✔ | ✔ | Mandar solicitud de amistad (máx. 50 pendientes enviadas y 50 recibidas). Si ya había una al revés, quedan amigos |
| `POST /api/solicitud/responder` | ✔ | | Aceptar o rechazar una solicitud recibida. Máx. 200 amigos por persona, en los dos lados |
| `POST /api/csp` | | | Recibe los informes de la Content-Security-Policy y los deja en los registros |
| `POST /api/amigos/quitar` | ✔ | | Dejar de ser amigos (borra los dos sentidos) |

"Tope diario" quiere decir que la acción cuenta para el límite de **80 acciones por conexión (hash de IP) al día**.

**Crons** (horas en UTC):

- `17 8 * * *`, todos los días a las 3:17 a. m. de Bogotá: borra sesiones vencidas, conteos de más de 3 días y bloqueos de contraseña que ya pasaron.
- `0 * 31 12 *`, cada hora del 31 de diciembre en UTC (del 30 de diciembre a las 7 p. m. al 31 a las 6 p. m. en Bogotá): manda el correo del resumen, hasta 40 por ejecución, a quien lo pidió. Solo envía si están `RESEND_API_KEY`, `CORREO_DESDE` y `URL_APP`, y desde las 9 a. m. de Bogotá del día `RESUMEN_DESDE`. Cada cuenta se marca como `enviando` antes de mandar (nunca recibe dos correos), un destinatario que falla vuelve a la fila sin frenar a los demás, y a Resend se le manda una clave de idempotencia. Quedan 10 ejecuciones útiles, o sea hasta 400 correos.

## Seguridad y privacidad

- **Contraseñas:** PBKDF2-SHA256 con 100.000 iteraciones (el máximo de Web Crypto en Workers) y una sal aleatoria de 16 bytes por usuario. La comparación es de tiempo constante. Cuando el usuario no existe, igual se calcula un hash para no revelarlo por el tiempo de respuesta.
- **Sesiones:** token aleatorio `bm_` + 32 bytes. En la base solo se guarda su SHA-256. Vence a los 180 días. El cliente lo guarda en localStorage y lo manda como `Bearer`. No hay cookies, así que no aplica CSRF.
- **Fuerza bruta:** cada intento de ingreso cuenta para el tope de 80 acciones por IP al día, y 5 fallos seguidos bloquean esa cuenta 15 minutos. Con `TURNSTILE_SECRET` puesto, crear cuenta y entrar también piden captcha.
- **IP:** nunca se guarda, solo `SHA-256(IP_SALT + IP)`. Sin `IP_SALT`, el Worker no escribe nada en vez de usar una sal conocida.
- **Qué ven los amigos:** nombre, @usuario, avatar, frase, diario, Por probar y favoritos. Para ser amigos hace falta aceptar: una solicitud por @ o una invitación por enlace, que el cliente nunca acepta solo. El correo no se le muestra a nadie.
- **Autorización de datos (Ley 1581 de 2012):** crear cuenta exige marcar la casilla que enlaza a la política de El Espectador, y la fecha queda en `cuentas.acepto_datos`. A las cuentas anteriores se les pide una vez al entrar.
- **Al cerrar sesión** se borran del navegador el diario, los favoritos, los votos y cualquier invitación pendiente.
- **Entradas del usuario:** todo texto se limpia y se corta en el servidor (nombre 30, reseña 500, frase 60). El cliente escapa todo lo que pinta (`escapar()`). Las consultas usan siempre parámetros (`.bind`), nunca texto concatenado del usuario.
- **Cabeceras:** `public/_headers` pone `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` y una **Content-Security-Policy en modo solo informe** (no bloquea, avisa a `/api/csp`). Las respuestas de la API van con `no-store`, `nosniff`, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`.
- **Validaciones:** coordenadas dentro de Bogotá, precio entre $100 y $50.000, calificación de 0,5 a 5 de media en media, fecha de la entrada que no esté en el futuro.

## Pendientes conocidos

El detalle está en `docs/RESPUESTA-AUDITORIA.md`. En corto:

1. **Recuperar contraseña:** no existe. Necesita el correo transaccional (Resend y dominio propio).
2. **Pasar la CSP de "solo informe" a obligatoria**, después de unos días sin informes en `/api/csp`.
3. **Captcha y correo apagados** hasta tener las claves (Turnstile, Resend) y el dominio propio.
4. **Proveedor del mapa:** se está evaluando cambiar MapTiler. Mientras tanto, la llave debería limitarse al dominio de la app en el panel de MapTiler.
5. **Ambiente de pruebas y respaldos:** hoy cada push a `main` va a producción. Falta un Worker y una base de staging, y un respaldo mensual programado de D1.
6. **Tabla obsoleta `probados`** en producción. Ver el final de `base/esquema.sql`.
7. **Borrar la cuenta** desde la app: no existe todavía.

## Marca

- El logo de El Espectador (`public/img/el-espectador.webp`) es el archivo oficial, solo redimensionado. No se le cambia color, proporción ni fondo. Va en el encabezado de 50 px de todas las vistas, sobre "APETITOSOS" en la bienvenida y en el pie.
- El aliado tiene su propio espacio ("Con el apoyo de"), nunca junto al logo de El Espectador. Si `ALIADO_LOGO` apunta a otro dominio, hay que agregarlo a `img-src` en la CSP de `public/_headers`.

## Decisiones que pueden parecer raras

- **Los nombres `buenamuela.*` y `mejorbunuelo.*`** en las claves de localStorage, y la base `buena-muela`, vienen de los nombres anteriores del proyecto. Cambiarlos cerraría la sesión de todos y desconectaría el diario guardado en cada navegador. Se dejan así a propósito.
- **Cliente sin empaquetador:** `app.js` es un solo archivo, a propósito, para un prototipo sin paso de compilación. Si el proyecto crece, conviene separarlo en módulos con un empaquetador (Vite, por ejemplo).
- **El registro dice "Ese usuario ya existe":** el informe pidió un mensaje uniforme para no revelar qué usuarios existen. No se puede: quien se registra necesita saber que debe elegir otro. La enumeración queda frenada con el tope por conexión y el captcha, y de todas formas el @ de cada persona lo ven sus amigos.
- **"Entrar con Google" (Supabase) se quitó** el 23 de noviembre de 2026: quedó solo el usuario y contraseña propios. Sigue en el historial de git por si se retoma.

## Tareas comunes de operación

Se corren en Cloudflare → D1 → `buena-muela` → Console.

```sql
-- Ocultar un sitio
UPDATE lugares SET estado = 'oculto' WHERE id = 'L-xxxxxxxxxx';

-- Ranking
SELECT nombre, votos, probados FROM lugares WHERE estado = 'visible' ORDER BY votos DESC;

-- Últimas reseñas
SELECT e.fecha, l.nombre, e.cal, e.resena
FROM entradas e JOIN lugares l ON l.id = e.id_lugar
ORDER BY e.creado DESC LIMIT 30;

-- Publicar una lista
INSERT INTO listas (id, titulo, autor, ids_lugares, estado, orden, fecha)
VALUES ('lista-xxx', 'Título', 'Autora', 'L-aaa,L-bbb,L-ccc', 'publicada', 1, date('now'));
```

## Para presentaciones

`?demo=wrapped` al final de la dirección muestra un resumen anual de ejemplo con datos inventados. No guarda nada.
