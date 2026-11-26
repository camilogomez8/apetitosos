-- Apetitosos · esquema de la base D1 (binding DB, base "buena-muela").
--
-- Es el esquema completo tal como está en producción (26 nov. 2026, después de las migraciones
-- de base/migraciones/).
-- Sirve para crear una base nueva desde cero:
--   npx wrangler d1 execute DB --local  --file base/esquema.sql   (para probar en tu computador)
--   npx wrangler d1 execute DB --remote --file base/esquema.sql   (base nueva en Cloudflare)
-- Todo es "IF NOT EXISTS", así que correrlo dos veces no daña nada.
--
-- Convenciones:
--   · Fechas y horas en texto ISO 8601 (UTC). "fecha" de una entrada es el día en Bogotá (AAAA-MM-DD).
--   · id_dispositivo: identificador al azar que cada navegador guarda en localStorage. No es un dato personal
--     ni una credencial: lo que vale para leer y escribir es la cuenta (id_perfil). Se conserva para lo que se
--     anotó sin cuenta antes de que fuera obligatoria.
--   · id de perfil: 'u-' + UUID.
--   · ip_hash: SHA-256 de (IP_SALT + IP). La IP nunca se guarda.

-- =============== Sitios, votos y listas ===============

CREATE TABLE IF NOT EXISTS lugares (
  id TEXT PRIMARY KEY,                   -- 'L-' + 10 caracteres
  nombre TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  barrio TEXT DEFAULT '',
  precio INTEGER,                        -- pesos colombianos
  plato TEXT NOT NULL DEFAULT 'buñuelo',
  creado TEXT NOT NULL,
  creador TEXT,                          -- id_dispositivo de quien lo agregó
  estado TEXT NOT NULL DEFAULT 'visible',-- 'visible' | 'oculto'
  votos INTEGER NOT NULL DEFAULT 0,      -- contador, se mantiene al votar
  probados INTEGER NOT NULL DEFAULT 0    -- contador de personas que lo anotaron
);
CREATE INDEX IF NOT EXISTS idx_lugares_plato ON lugares(plato, estado);

-- Un voto por sitio y por persona: por dispositivo y, con cuenta, por perfil.
CREATE TABLE IF NOT EXISTS votos (
  id_lugar TEXT NOT NULL,
  plato TEXT NOT NULL DEFAULT 'buñuelo',
  fecha TEXT NOT NULL,
  id_dispositivo TEXT NOT NULL,
  ip_hash TEXT,
  id_perfil TEXT,                        -- vacío solo en votos viejos, de antes de exigir cuenta
  PRIMARY KEY (id_lugar, id_dispositivo)
);
CREATE INDEX IF NOT EXISTS idx_votos_perfil ON votos(id_lugar, id_perfil);

-- Listas editoriales (las carga el equipo desde la consola de D1).
CREATE TABLE IF NOT EXISTS listas (
  id TEXT PRIMARY KEY,
  titulo TEXT NOT NULL,
  autor TEXT DEFAULT '',
  descripcion TEXT DEFAULT '',
  fuente_nombre TEXT DEFAULT '',
  fuente_url TEXT DEFAULT '',
  ids_lugares TEXT DEFAULT '',           -- ids de lugares separados por coma, en orden
  estado TEXT NOT NULL DEFAULT 'publicada',
  orden INTEGER DEFAULT 99,
  fecha TEXT
);

-- Listas que sigue cada persona.
CREATE TABLE IF NOT EXISTS seguimientos (
  id_dispositivo TEXT NOT NULL,
  id_lista TEXT NOT NULL,
  fecha TEXT NOT NULL,
  id_perfil TEXT,                        -- cuenta dueña (NULL solo en datos viejos sin cuenta)
  PRIMARY KEY (id_dispositivo, id_lista)
);
CREATE INDEX IF NOT EXISTS idx_seguimientos_perfil ON seguimientos(id_perfil);

-- Tope diario de acciones por conexión (ip_hash) contra abuso. También guarda cupos por cuenta,
-- con claves que empiezan por 'cupo|' (búsquedas de @usuario, invitaciones aceptadas).
CREATE TABLE IF NOT EXISTS limites (
  ip_hash TEXT NOT NULL,
  dia TEXT NOT NULL,
  acciones INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, dia)
);

-- =============== Diario ===============

-- Cada visita a un sitio es una entrada con fecha (como el diario de Letterboxd).
CREATE TABLE IF NOT EXISTS entradas (
  id TEXT PRIMARY KEY,                   -- 'E-' + 12 caracteres
  id_lugar TEXT NOT NULL,
  plato TEXT NOT NULL,
  id_dispositivo TEXT NOT NULL,
  fecha TEXT NOT NULL,                   -- día en que lo comió (AAAA-MM-DD), nunca en el futuro
  cal REAL NOT NULL,                     -- 0,5 a 5, de media en media
  volveria INTEGER,                      -- 1 sí, 0 no, NULL sin responder
  resena TEXT,                           -- máximo 500 caracteres
  creado TEXT NOT NULL,
  ip_hash TEXT,
  id_perfil TEXT                         -- cuenta autora (NULL solo en datos viejos sin cuenta)
);
CREATE INDEX IF NOT EXISTS idx_entradas_dispositivo ON entradas(id_dispositivo);
CREATE INDEX IF NOT EXISTS idx_entradas_perfil ON entradas(id_perfil, id_lugar);
CREATE INDEX IF NOT EXISTS idx_entradas_lugar ON entradas(id_lugar);

CREATE TABLE IF NOT EXISTS por_probar (
  id_dispositivo TEXT NOT NULL,
  id_lugar TEXT NOT NULL,
  plato TEXT NOT NULL,
  fecha TEXT NOT NULL,
  id_perfil TEXT,                        -- cuenta dueña (NULL solo en datos viejos sin cuenta)
  PRIMARY KEY (id_dispositivo, id_lugar)
);
CREATE INDEX IF NOT EXISTS idx_por_probar_perfil ON por_probar(id_perfil);

-- =============== Cuentas, perfiles y amigos ===============

CREATE TABLE IF NOT EXISTS perfiles (
  id TEXT PRIMARY KEY,                   -- 'u-' + UUID, el mismo de cuentas.id_perfil
  nombre TEXT NOT NULL,                  -- como lo ven sus amigos
  color TEXT NOT NULL DEFAULT 'dorado',  -- sin uso visible, se conserva
  codigo TEXT NOT NULL UNIQUE,           -- código de invitación (?amigo=CODIGO)
  creado TEXT NOT NULL,
  cuatro TEXT,                           -- "Mis favoritos": JSON con 4 ids de lugar o null
  avatar TEXT                            -- JSON {p: personaje, g: gesto 0|1, f: color, frase}
);

CREATE TABLE IF NOT EXISTS cuentas (
  id_perfil TEXT PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE,          -- minúsculas, 3 a 20 caracteres [a-z0-9._]
  clave_hash TEXT NOT NULL,              -- PBKDF2-SHA256, 100.000 iteraciones
  sal TEXT NOT NULL,                     -- sal aleatoria por usuario
  correo TEXT,                           -- opcional, solo para el correo del resumen
  avisar INTEGER NOT NULL DEFAULT 0,     -- 1 = quiere el correo del resumen
  avisado TEXT,                          -- cuándo se le mandó ('enviando' mientras sale, 'sin-datos' si no tenía nada)
  creado TEXT NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0,   -- contraseñas fallidas seguidas
  bloqueo_hasta TEXT,                    -- ISO UTC: hasta cuándo no acepta contraseñas (5 fallos = 15 min)
  acepto_datos TEXT                      -- cuándo aceptó la política de tratamiento de datos (Ley 1581 de 2012)
);

CREATE TABLE IF NOT EXISTS sesiones (
  token_hash TEXT PRIMARY KEY,           -- SHA-256 del token; el token nunca se guarda
  id_perfil TEXT NOT NULL,
  creado TEXT NOT NULL,
  vence TEXT NOT NULL                    -- 180 días. La limpieza diaria borra las vencidas.
);
CREATE INDEX IF NOT EXISTS idx_sesiones_perfil ON sesiones(id_perfil);

-- Navegadores unidos a una cuenta. Solo sirve para pasarle a su dueño lo que anotó sin cuenta en ese
-- navegador. Un navegador nunca cambia de dueño. Ya no da permiso de leer ni de escribir nada.
CREATE TABLE IF NOT EXISTS perfil_dispositivos (
  id_dispositivo TEXT PRIMARY KEY,
  id_perfil TEXT NOT NULL,
  fecha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perfil_dispositivos ON perfil_dispositivos(id_perfil);

-- Amistad simétrica: se guardan las dos direcciones, (a, b) y (b, a).
CREATE TABLE IF NOT EXISTS amistades (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (a, b)
);

-- Solicitudes por @usuario. Al aceptarlas se borran y se crea la amistad.
CREATE TABLE IF NOT EXISTS solicitudes (
  de TEXT NOT NULL,
  para TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (de, para)
);
CREATE INDEX IF NOT EXISTS solicitudes_para ON solicitudes(para);

-- "Me provoca" a la anotación de un amigo.
CREATE TABLE IF NOT EXISTS provocas (
  id_entrada TEXT NOT NULL,
  id_perfil TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (id_entrada, id_perfil)
);

-- =============== Obsoleto ===============
-- La base de producción todavía tiene la tabla "probados" (y su índice idx_probados_dispositivo),
-- de la primera versión. Sus datos se pasaron a "entradas" y el código ya no la usa.
-- Se puede borrar cuando TI lo apruebe:
--   DROP INDEX IF EXISTS idx_probados_dispositivo;
--   DROP TABLE IF EXISTS probados;
