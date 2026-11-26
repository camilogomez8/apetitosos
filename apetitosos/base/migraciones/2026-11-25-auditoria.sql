-- Migración de la auditoría de seguridad (25 nov. 2026). Ya aplicada en producción.
--
-- 1. El diario deja de depender del teléfono: cada entrada, "Por probar" y lista seguida guarda la cuenta
--    que la escribió (id_perfil). Antes, de quién era una reseña se deducía de perfil_dispositivos, y por eso
--    quien conociera el id de un teléfono ajeno podía quedarse con su diario (hallazgos #1 y #3).
-- 2. Bloqueo por cuenta tras varios intentos fallidos de contraseña (hallazgo #4).
--
-- Se corre una sola vez:  npx wrangler d1 execute DB --remote --file base/migraciones/2026-11-25-auditoria.sql

ALTER TABLE entradas ADD COLUMN id_perfil TEXT;
ALTER TABLE por_probar ADD COLUMN id_perfil TEXT;
ALTER TABLE seguimientos ADD COLUMN id_perfil TEXT;
ALTER TABLE cuentas ADD COLUMN intentos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cuentas ADD COLUMN bloqueo_hasta TEXT;

-- Lo que ya estaba unido a una cuenta pasa a esa cuenta. Lo anónimo queda con id_perfil NULL y se le asigna
-- a su dueño la próxima vez que entre desde ese mismo navegador.
UPDATE entradas SET id_perfil = (SELECT id_perfil FROM perfil_dispositivos pd WHERE pd.id_dispositivo = entradas.id_dispositivo) WHERE id_perfil IS NULL;
UPDATE por_probar SET id_perfil = (SELECT id_perfil FROM perfil_dispositivos pd WHERE pd.id_dispositivo = por_probar.id_dispositivo) WHERE id_perfil IS NULL;
UPDATE seguimientos SET id_perfil = (SELECT id_perfil FROM perfil_dispositivos pd WHERE pd.id_dispositivo = seguimientos.id_dispositivo) WHERE id_perfil IS NULL;
UPDATE votos SET id_perfil = (SELECT id_perfil FROM perfil_dispositivos pd WHERE pd.id_dispositivo = votos.id_dispositivo) WHERE id_perfil IS NULL;

CREATE INDEX IF NOT EXISTS idx_entradas_perfil ON entradas(id_perfil, id_lugar);
CREATE INDEX IF NOT EXISTS idx_por_probar_perfil ON por_probar(id_perfil);
CREATE INDEX IF NOT EXISTS idx_seguimientos_perfil ON seguimientos(id_perfil);
