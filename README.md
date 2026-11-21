# Apetitosos · ¿Dónde está el mejor buñuelo de Bogotá?

App en Cloudflare Workers con base de datos D1, captcha Turnstile y amigos con "Entrar con Google" (Supabase).

- `public/index.html`: la página. Tiene cinco pestañas: Inicio, Buscar, Anotar, Actividad y Perfil.
- `src/index.js`: el servidor. Atiende las rutas `/api/...` y habla con la base.
- `wrangler.jsonc`: la configuración, con el nombre, la base de datos y las claves públicas.
- `base/esquema.sql`: las tablas, como referencia.

## Claves

| Dónde | Nombre | Qué es |
| --- | --- | --- |
| `wrangler.jsonc` → `vars` | `MAPTILER_KEY` | Clave del mapa (pública) |
| `wrangler.jsonc` → `vars` | `TURNSTILE_SITE_KEY` | Clave del captcha que va en la página (pública) |
| `wrangler.jsonc` → `vars` | `SUPABASE_URL` | Dirección del proyecto de Supabase (pública) |
| `wrangler.jsonc` → `vars` | `SUPABASE_ANON_KEY` | Llave "anon" o "publishable" de Supabase (pública) |
| Panel de Cloudflare → Worker → Settings → Variables and Secrets | `TURNSTILE_SECRET` | Clave secreta del captcha |
| Panel de Cloudflare → Worker → Settings → Variables and Secrets | `IP_SALT` | Texto secreto para cifrar las IP |

Lo que pasa si falta alguna:
- Sin las dos de Turnstile, la app funciona igual pero sin captcha.
- Sin las dos de Supabase, la app funciona sin amigos. La pestaña Actividad dice "Muy pronto".

## Qué guarda la base

- `lugares`, `votos`, `listas`: el mapa, el ranking y las listas de medios.
- `entradas`: el diario. Cada vez que alguien come en un sitio queda una entrada con fecha, puntaje (de medio en medio), "¿volverías?" y una reseña opcional.
- `por_probar` y `seguimientos`: el "Por probar" y las listas que sigue cada teléfono.
- `perfiles`, `perfil_dispositivos`, `amistades`, `provocas`: las cuentas, los amigos y los "me provoca". De Google solo se guarda el número interno del usuario, no el correo.

La tabla vieja `probados` ya se pasó a `entradas` y no se usa.

## Tareas comunes (Cloudflare → D1 → buena-muela → Console)

Ocultar un sitio:

    UPDATE lugares SET estado = 'oculto' WHERE id = 'L-xxxxxxxxxx';

Publicar la lista de una invitada cuando llegue:

    UPDATE listas SET ids_lugares = 'R-granihot, L-xxxxxxxxxx', estado = 'publicada' WHERE id = 'lista-veronica';

Ver el ranking:

    SELECT nombre, votos, probados FROM lugares WHERE estado = 'visible' ORDER BY votos DESC;

Ver las últimas reseñas:

    SELECT e.fecha, l.nombre, e.cal, e.resena FROM entradas e JOIN lugares l ON l.id = e.id_lugar ORDER BY e.creado DESC LIMIT 30;

## Para el pitch

Abre la app con `?demo=wrapped` al final de la dirección para ver un resumen buñuelero de ejemplo. No guarda nada.
