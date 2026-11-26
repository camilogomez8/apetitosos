# Respuesta a la revisión UX

Documento revisado: *Apetitosos · Revisión UX. Puntos a tener en cuenta* (noviembre de 2026).
Respuesta: 26 de noviembre de 2026. Todo se probó en un celular pequeño (360 × 640), en un celular estándar (390 × 844) y en escritorio (1400 × 900).

| Punto de la revisión | Qué se hizo |
| --- | --- |
| No se ve el logo de El Espectador | Encabezado de 50 px en todas las vistas, con el logo oficial centrado y el círculo de perfil a la derecha. También va sobre "APETITOSOS" en la bienvenida y en el pie de página. El archivo es el oficial, solo redimensionado, sin cambios de color, proporción ni elementos añadidos. |
| Espacio para un aliado comercial | "Con el apoyo de" debajo del botón de la bienvenida, sello en el banner de temporada, sello en el mapa y línea en el pie. Está **apagado** hasta que haya un acuerdo firmado: se enciende con `ALIADO_NOMBRE` y `ALIADO_LOGO` en `wrangler.jsonc`, y el logo de Alpina ya está en el proyecto. Para verlo sin activarlo para nadie, basta abrir la app con `?aliado=alpina` al final de la dirección. El aliado nunca comparte espacio con el logo de El Espectador. |
| El botón de la bienvenida no se ve en algunos celulares | La ilustración ahora se ajusta a la altura de la pantalla. En 360 × 640 el botón queda entero y a la vista sin desplazarse. |
| El orden del ranking confunde | El Top 10 dejó de ordenarse solo por votos. Ahora usa un **puntaje combinado** (promedio bayesiano): cada calificación cuenta con su nota, cada voto como un 5 y a cada sitio se le suman 3 opiniones con la nota media de Bogotá. Así, un sitio con pocas opiniones no le gana a uno con muchas. Junto a las pestañas hay un botón (i) "¿Cómo se calcula?" que lo explica en lenguaje sencillo. |
| El número del ranking tapa el nombre | El puesto va en línea antes del nombre, y los nombres largos se cortan en dos líneas. Los tres primeros llevan sello de oro, plata y bronce, y el primero tiene además un borde dorado. |
| El buñuelo parece una carita triste | Se redibujó: salieron la línea ondulada y los puntos que formaban la "cara". Ahora tiene grietas doradas de fritura arriba a la derecha y poros sueltos. |
| Todas las tarjetas se ven iguales | Cada tarjeta toma el color y el sello de su zona aproximada (Norte, Centro, Sur, Occidente). Las fotos reales de los sitios quedan pendientes: hace falta tomarlas o conseguir los permisos. |
| La barra inferior no tiene etiquetas | Ahora dice Inicio, Amigos y Perfil. |
| La barra tapa contenido | El contenido termina en un pie de página con espacio de sobra para la barra flotante y el área segura del teléfono. Se verificó con medidas que el botón "Crear mi cuenta", la casilla del correo y la última tarjeta no quedan debajo de la barra. |
| El botón de Perfil no se parece al de arriba | El botón de Perfil de la barra muestra la misma cara que el círculo del encabezado: tu personaje o, si no has entrado, el oso. |
| No hay política de datos, términos, contacto ni quién está detrás | Pie de página en todas las vistas con "Apetitosos es un proyecto de El Espectador", la política de tratamiento de datos, los términos y el contacto. Crear cuenta exige marcar la autorización de tratamiento de datos (Ley 1581 de 2012), y la fecha queda guardada. A las cuentas que ya existían se les pide una vez al entrar. Mientras jurídica confirma, los enlaces apuntan a las páginas vigentes de elespectador.com y se cambian con `URL_POLITICA_DATOS`, `URL_TERMINOS` y `URL_CONTACTO`. |
| Medias notas solo en algunas calificaciones | Todas las calificaciones aceptan medias notas desde antes: el problema era que nadie lo descubría. Ahora hay una barra deslizable de ½ en ½, marcada de ½ a 5, y una línea que explica que cada buñuelo se llena por mitades. Tocar los buñuelos sigue funcionando. |
| El ícono del calendario tapa la fecha | La pastilla dice "Otra fecha" y, cuando eliges una, muestra la fecha completa ("15 nov."). El selector del sistema se abre al tocar cualquier parte de la pastilla. |

## Preguntas abiertas de la revisión

- **¿Se puede entrar con la cuenta del portal de El Espectador?** Hoy no. Sería posible si el portal ofrece inicio de sesión compartido para aplicaciones externas (OAuth u OpenID Connect). Es una conversación con TI del periódico.
- **¿Para qué se usará la base de datos?** Hoy solo sirve para que la app funcione: tu diario, tus amigos y el correo del resumen, si lo pediste. Cualquier otro uso tiene que estar en la política de tratamiento de datos que se enlaza en el registro. Es una decisión de negocio y de jurídica.
