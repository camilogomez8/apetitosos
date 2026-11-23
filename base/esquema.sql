-- Tablas de la app. Ya están creadas en la base "buena-muela" de Cloudflare.
-- Este archivo queda como referencia (o para crear una base nueva desde cero).
CREATE TABLE IF NOT EXISTS lugares (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  barrio TEXT DEFAULT '',
  precio INTEGER,
  plato TEXT NOT NULL DEFAULT 'buñuelo',
  creado TEXT NOT NULL,
  creador TEXT,
  estado TEXT NOT NULL DEFAULT 'visible',
  votos INTEGER NOT NULL DEFAULT 0,
  probados INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lugares_plato ON lugares(plato, estado);
CREATE TABLE IF NOT EXISTS votos (
  id_lugar TEXT NOT NULL,
  plato TEXT NOT NULL DEFAULT 'buñuelo',
  fecha TEXT NOT NULL,
  id_dispositivo TEXT NOT NULL,
  ip_hash TEXT,
  PRIMARY KEY (id_lugar, id_dispositivo)
);
CREATE TABLE IF NOT EXISTS probados (
  id_lugar TEXT NOT NULL,
  plato TEXT NOT NULL DEFAULT 'buñuelo',
  fecha TEXT NOT NULL,
  id_dispositivo TEXT NOT NULL,
  calificacion INTEGER NOT NULL CHECK (calificacion BETWEEN 1 AND 5),
  PRIMARY KEY (id_lugar, id_dispositivo)
);
CREATE TABLE IF NOT EXISTS listas (
  id TEXT PRIMARY KEY,
  titulo TEXT NOT NULL,
  autor TEXT DEFAULT '',
  descripcion TEXT DEFAULT '',
  fuente_nombre TEXT DEFAULT '',
  fuente_url TEXT DEFAULT '',
  ids_lugares TEXT DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'publicada',
  orden INTEGER DEFAULT 99,
  fecha TEXT
);
CREATE TABLE IF NOT EXISTS limites (
  ip_hash TEXT NOT NULL,
  dia TEXT NOT NULL,
  acciones INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, dia)
);

-- ---------- Amigos (entrar con Google vía Supabase) ----------
CREATE TABLE IF NOT EXISTS perfiles (
  id TEXT PRIMARY KEY,               -- 'g-' + id interno del usuario en Supabase (no se guarda el correo)
  nombre TEXT NOT NULL,              -- como lo ven sus amigos
  color TEXT NOT NULL DEFAULT 'dorado',
  codigo TEXT NOT NULL UNIQUE,       -- código de invitación (?amigo=CODIGO)
  creado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS perfil_dispositivos (
  id_dispositivo TEXT PRIMARY KEY,   -- un teléfono pertenece a una sola cuenta
  id_perfil TEXT NOT NULL,
  fecha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perfil_dispositivos ON perfil_dispositivos(id_perfil);
CREATE TABLE IF NOT EXISTS amistades (
  a TEXT NOT NULL,                   -- se guardan las dos direcciones: (a, b) y (b, a)
  b TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_probados_dispositivo ON probados(id_dispositivo);

-- ---------- Diario (cada visita es una entrada con fecha) ----------
CREATE TABLE IF NOT EXISTS entradas (
  id TEXT PRIMARY KEY,
  id_lugar TEXT NOT NULL,
  plato TEXT NOT NULL,
  id_dispositivo TEXT NOT NULL,
  fecha TEXT NOT NULL,               -- día en que lo comió (AAAA-MM-DD)
  cal REAL NOT NULL,                 -- 0,5 a 5, de media en media
  volveria INTEGER,                  -- 1 sí, 0 no, vacío sin responder
  resena TEXT,
  creado TEXT NOT NULL,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_entradas_dispositivo ON entradas(id_dispositivo);
CREATE INDEX IF NOT EXISTS idx_entradas_lugar ON entradas(id_lugar);
CREATE TABLE IF NOT EXISTS por_probar (
  id_dispositivo TEXT NOT NULL,
  id_lugar TEXT NOT NULL,
  plato TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (id_dispositivo, id_lugar)
);
CREATE TABLE IF NOT EXISTS provocas (     -- "me provoca" a la reseña de un amigo
  id_entrada TEXT NOT NULL,
  id_perfil TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (id_entrada, id_perfil)
);
CREATE TABLE IF NOT EXISTS seguimientos (  -- listas que sigue cada teléfono
  id_dispositivo TEXT NOT NULL,
  id_lista TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (id_dispositivo, id_lista)
);
-- La tabla vieja "probados" se pasó a "entradas" una sola vez y ya no se usa.

-- ---------- Cuentas propias (usuario y contraseña) ----------
CREATE TABLE IF NOT EXISTS cuentas (
  id_perfil TEXT PRIMARY KEY,          -- 'u-' + uuid, el mismo id de perfiles
  usuario TEXT NOT NULL UNIQUE,        -- en minúsculas
  clave_hash TEXT NOT NULL,            -- PBKDF2-SHA256, 100.000 vueltas
  sal TEXT NOT NULL,
  correo TEXT,                         -- opcional
  avisar INTEGER NOT NULL DEFAULT 0,   -- 1 = quiere el correo del resumen
  avisado TEXT,                        -- cuándo se le mandó
  creado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash TEXT PRIMARY KEY,         -- huella SHA-256 del token, nunca el token
  id_perfil TEXT NOT NULL,
  creado TEXT NOT NULL,
  vence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiones_perfil ON sesiones(id_perfil);

-- ---------- Un voto por persona y "Mis cuatro" en el servidor (21 nov. 2026) ----------
ALTER TABLE votos ADD COLUMN id_perfil TEXT;
ALTER TABLE perfiles ADD COLUMN cuatro TEXT;          -- JSON con 4 ids de sitio o null
ALTER TABLE perfiles ADD COLUMN avatar TEXT;          -- JSON {p: personaje, g: gesto 0/1, f: color del círculo, frase}
CREATE INDEX IF NOT EXISTS idx_votos_perfil ON votos(id_lugar, id_perfil);

-- Solicitudes de amistad por @usuario. Al aceptar se borran y se crea la amistad en los dos sentidos.
CREATE TABLE IF NOT EXISTS solicitudes (
  de TEXT NOT NULL,
  para TEXT NOT NULL,
  fecha TEXT NOT NULL,
  PRIMARY KEY (de, para)
);
CREATE INDEX IF NOT EXISTS solicitudes_para ON solicitudes (para);
