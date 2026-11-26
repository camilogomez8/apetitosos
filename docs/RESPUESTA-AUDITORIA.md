# Respuesta al informe de auditoría de seguridad

Informe: *Apetitosos — Auditoría de seguridad. Informe para el desarrollador* (24 de noviembre de 2026, corrida `apetitosos-run-1`).
Respuesta: 25 de noviembre de 2026.

Gracias por el informe. Revisamos cada hallazgo contra el código y los diez son correctos. Corregimos los diez y los leads que dependían solo del código. Quedan pendientes los puntos que dependen de paneles externos o de decisiones de producto (sección 4).

Las referencias van por nombre de función, porque los números de línea del informe cambiaron con los arreglos.

## 1. Cambio de fondo: el diario ya no depende del teléfono

Los hallazgos #1 y #3 tenían una causa común, bien descrita en el §1 del informe: la autoría de una reseña se deducía de `perfil_dispositivos`, así que el `id_dispositivo` funcionaba como credencial. En vez de solo cortar el UPSERT, como proponía el fix mínimo, cambiamos el modelo:

- **Toda escritura exige sesión** (votar, crear sitio, anotar, borrar, Por probar, seguir listas), como recomendó el informe en #3 a corto plazo.
- **Cada fila guarda la cuenta que la escribió.** Se agregó `id_perfil` a `entradas`, `por_probar` y `seguimientos` (`votos` ya lo tenía). Todas las lecturas y escrituras del diario, la actividad, el perfil de amigo, la nota de cada sitio y el correo del resumen filtran por `id_perfil`, nunca por dispositivo.
- **`perfil_dispositivos` dejó de ser ACL.** Ahora solo sirve para pasarle a su dueño lo que anotó sin cuenta antes de este cambio, cuando entra desde ese mismo navegador (`reclamarDispositivo`). Un navegador que ya es de otra cuenta **nunca cambia de dueño** (`ON CONFLICT DO NOTHING`). En ese caso el servidor responde `dispositivoAjeno: true` y el cliente estrena un id nuevo.
- **Migración:** `base/migraciones/2026-11-25-auditoria.sql`, ya aplicada en producción. Asignó su cuenta a los 3 registros de entradas y 3 de votos que estaban unidos a una. Quedan 6 entradas anónimas de antes, que pasarán a su dueño si entra desde el mismo navegador.

## 2. Hallazgos confirmados

| # | Hallazgo | Estado | Qué se hizo |
| --- | --- | --- | --- |
| 1 | Reatribución del diario (rebinding) | **Corregido** | Ver §1. `unirDispositivo` se reemplazó por `reclamarDispositivo` (`DO NOTHING` + reclamo solo de filas sin dueño). `?d=` desapareció de `/api/yo` y `/api/diario`. Las ramas "quitar" borran solo filas con el `id_perfil` de quien llama. |
| 2 | Amistad forzada por `?amigo=` | **Corregido** | `cargarYo()` ya no canjea. `confirmarInvitacionPendiente()` muestra "X te invitó… Aceptar / Ahora no" y solo "Aceptar" llama a `/api/amigos`. "Ahora no" borra la invitación pendiente. |
| 3 | `id_dispositivo` elegido por el cliente | **Corregido** | Ver §1. El dispositivo ya no autoriza nada. Las cifras públicas (`lugares.probados`, `nota`) se cuentan por persona: la nota usa la última calificación de cada `id_perfil` con `ROW_NUMBER()`, en vez de una subconsulta por fila. No firmamos el id con HMAC porque dejó de ser credencial. |
| 4 | Fuerza bruta sin bloqueo por cuenta | **Corregido** | Columnas `cuentas.intentos` y `cuentas.bloqueo_hasta`. 5 fallos seguidos bloquean la cuenta 15 minutos, y entrar bien pone el contador en 0. `registrar()` y `entrar()` pasan por `controlar(…, false, false)`, así que exigen captcha cuando `TURNSTILE_SECRET` esté configurado. El cliente ya envía el token de Turnstile en los dos formularios. |
| 5 | Oráculo del código de invitación | **Corregido** | La consulta pasó a `POST /api/invitacion`, con el código en el cuerpo, y gasta cupo de `controlar()`. En `agregarAmigo` el cupo se gasta **antes** de consultar el código, con un techo adicional de 20 canjes por cuenta al día. Con 80 consultas por IP al día, barrer 2³⁰ códigos no es viable. La respuesta sigue diciendo el nombre de quien invita, porque la pantalla de invitación lo necesita. |
| 6 | Barrido del directorio de usuarios | **Corregido** | `/api/buscar-amigo` tiene un cupo de 200 búsquedas por cuenta al día (`cuota()`, tabla `limites` con clave `cupo\|…`). No se usó `controlar()` porque la búsqueda corre mientras la persona escribe y se comería el tope de 80. |
| 7 | Enumeración en el registro | **Mitigado, con una diferencia** | Registro con captcha (si está activo) y tope por IP. **No** pusimos un mensaje uniforme: quien se registra necesita saber que el usuario está tomado para elegir otro. La "verificación diferida" exige correo obligatorio, y hoy es opcional. Además, el @usuario lo ven los amigos y aparece en la búsqueda, así que no es secreto. Si TI prefiere otra salida, la conversamos. |
| 8 | Tope de 200 amigos solo en quien inicia | **Corregido** | `hacerAmigos()` valida el tope de **las dos** cuentas y todos los caminos lo usan: invitación, aceptar solicitud y auto-aceptación cruzada. |
| 9 | Bandeja de solicitudes sin cota | **Corregido** | `mandarSolicitud()` cuenta también las **recibidas** del destinatario (máx. 50) y rechaza con mensaje claro. |
| 10 | Diario en el navegador tras cerrar sesión | **Corregido** | `salir()` borra `buenamuela.diario`, `buenamuela.cuatro`, los votos, la marca de actividad y la invitación pendiente, y vacía el estado en memoria. `leerDiarioGuardado()` solo rehidrata si hay sesión. |

## 3. Leads

| Lead | Estado | Detalle |
| --- | --- | --- |
| 1 · Cabeceras no llegan a producción | **Por verificar en el deploy** | `public/_headers` está en la ruta correcta. Lo más probable es que no se hubiera subido al repositorio en el deploy del 24. Las respuestas de `/api/*` ya traen sus propias cabeceras desde el Worker. Tras publicar: `curl -I` a `/` y a `/img/og-reposo.webp`. |
| 2 · Terceros sin SRI ni CSP | **Parcial** | Se separaron el JS y el CSS a `app.js` y `app.css` para poder usar CSP sin `unsafe-inline` en scripts. La CSP va en `_headers` en **modo solo informe**, con informes en `POST /api/csp` (registros del Worker). Se pasará a obligatoria tras unos días sin informes. El SRI del SDK de MapTiler queda pendiente porque se está evaluando cambiar de proveedor de mapa. Turnstile no admite SRI. `style-src` mantiene `'unsafe-inline'` por los atributos `style=""` del HTML. |
| 3 · Turnstile se carga apagado | **Corregido** | El `<script>` se quitó del HTML. `tokenCaptcha()` lo inyecta solo si hay `TURNSTILE_SITE_KEY`. |
| 4 · Llave de MapTiler | **Pendiente (panel)** | Ver §4. |
| 5 · Publicación sin red de seguridad | **Parcial** | `wrangler` quedó fijado en `4.162.0`, con `engines.node >= 20`, y el README documenta `npm ci` y el respaldo previo a cada migración. Staging y la configuración de Workers Builds quedan para el panel (§4). |
| 6 · Captcha omitido en rutas de abuso | **Parcial** | Registro y entrada ya piden captcha cuando esté activo. Las demás rutas sociales siguen con `sinCaptcha=true` a propósito: piden sesión, tienen tope por IP y cupos por cuenta. Activar Turnstile es decisión del panel (§4). |
| 7 · Sal de respaldo del hash de IP | **Corregido** | Sin `IP_SALT`, `controlar()` ya no usa `'sal-provisional'`: rechaza la acción ("en mantenimiento") y deja un error en los registros. `IP_SALT` está configurado en producción. |
| 8 · `id_dispositivo` en la URL | **Corregido** | Ya no viaja en ninguna URL. Además dejó de ser credencial (§1). |
| 9 · Código de invitación en la URL | **Corregido** | `/api/invitacion` es POST. El enlace `?amigo=` que comparten las personas se borra de la barra de direcciones apenas carga la página, con `history.replaceState`. |
| 10 · `/api/lugares` con subconsulta por fila | **Corregido** | La nota se calcula con una sola pasada de `ROW_NUMBER()`. |
| 11 · `/api/listas` sin filtrar | **Corregido** | `WHERE estado IN ('publicada', 'proximamente') … LIMIT 100`. Hoy producción solo tiene listas publicadas. |
| 12 · `/api/yo` sin LIMIT | **Corregido** | La lectura de calificaciones de amigos tiene `LIMIT 5000` y las de diario y Por probar tienen `LIMIT`. Los amigos ya tenían tope de 200. |
| 13 · El vínculo dispositivo-cuenta no se puede revocar | **Ya no aplica** | `perfil_dispositivos` dejó de dar acceso (§1). Cerrar sesión revoca el token, que es la única credencial. |
| 14 · `perfil_dispositivos` solo crece | **Corregido** | Ya no se inserta en cada petición, solo al crear cuenta o entrar. |
| 15 · Correo no idempotente | **Corregido** | Cada cuenta se marca `enviando` **antes** de llamar a Resend, con `UPDATE … WHERE avisado IS NULL OR avisado = 'sin-datos'`, y cada destinatario tiene su `try/catch`. Un fallo devuelve esa cuenta a la fila sin frenar el lote. A Resend se le manda `Idempotency-Key`. |
| 16 · "Sin datos" para siempre | **Corregido** | Las cuentas `sin-datos` se vuelven a revisar en las siguientes vueltas, después de las nuevas, por si anotaron más tarde. |

Además se agregó una **limpieza diaria** con el cron `17 8 * * *`: borra sesiones vencidas, conteos de más de 3 días y bloqueos de contraseña ya vencidos.

**Descartados (§5 del informe):** de acuerdo con los cinco.

## 4. Lo que queda del lado de los paneles (no es código)

Lo dejamos para después de la reunión del 26 de noviembre, porque depende de decisiones pendientes:

- **Proveedor de mapa:** se evalúa reemplazar MapTiler. Si se mantiene: limitar la llave por dominio (lead #4) y agregar SRI. Si se cambia: actualizar la CSP con el nuevo dominio.
- **Turnstile:** crear el widget, poner `TURNSTILE_SITE_KEY` y el secreto `TURNSTILE_SECRET`. El código ya está listo para usarlo en voto, sitio nuevo, registro y entrada.
- **Dominio propio**, para tener WAF y rate limiting de zona, HSTS, Turnstile con dominio verificado y Resend.
- **Staging:** un segundo Worker con su propia base D1, publicado desde otra rama.
- **Respaldo mensual de D1** (`wrangler d1 export`) y revisar que Workers Builds use `npm ci`.
- **CSP:** pasar de `Content-Security-Policy-Report-Only` a `Content-Security-Policy` cuando no lleguen informes.

## 5. Una diferencia de producto que dejamos registrada

Exigir cuenta para votar y anotar cierra el hallazgo #3, y así quedó. El equipo de producto prefería que votar siguiera siendo anónimo, para bajar la fricción en temporada. La alternativa era que los votos anónimos contaran y que la calificación y el "probado por" públicos salieran solo de cuentas. Lo plantearemos en la reunión. Si se retoma, el modelo por `id_perfil` lo permite sin volver a usar el dispositivo como credencial.

## 6. Cómo se verificó

- **Prueba de regresión de la API** (38 casos) sobre una base creada desde cero con `base/esquema.sql`. Reproduce el escenario de cada hallazgo:
  - Escrituras sin sesión, ruta por ruta.
  - Una segunda cuenta presentando el `id_dispositivo` de otra: no ve, no borra y no reasigna nada.
  - Un voto y una nota por persona.
  - 5 contraseñas malas seguidas, y después la correcta, rechazada durante el bloqueo.
  - `GET /api/invitacion` ya responde 404, y el `POST` gasta cupo.
  - La búsqueda número 201 del día se rechaza.
  - Bandeja llena con 50 solicitudes y tope de 200 amigos del lado de quien acepta.
  - Me provoca solo entre amigos, y cerrar sesión invalida el token.
- **Prueba en navegador** (Playwright, celular y escritorio):
  - Sin cuenta, "Votar" lleva a crear cuenta.
  - Con sesión, un enlace `?amigo=` muestra la confirmación, y "Ahora no" no crea la amistad.
  - Al cerrar sesión no queda nada en localStorage y, al recargar, no hay diario a la vista.
  - Entrar desde un navegador ajeno estrena un id.
  - Cero errores de consola y cero informes de CSP. El mapa estaba simulado en estas pruebas, así que la CSP con MapTiler real se valida en producción con los informes de `/api/csp`.
- **La migración** se probó sobre el esquema anterior y sobre una copia local con datos, antes de correrla en producción.
- **ESLint** sobre `src/index.js` y `public/app.js`, sin advertencias.
