-- Autorización de tratamiento de datos (Ley 1581 de 2012), 26 nov. 2026. Ya aplicada en producción.
-- Guarda cuándo aceptó cada cuenta la política de tratamiento de datos. Las cuentas anteriores quedan en NULL
-- y la app les pide aceptarla la próxima vez que entren.
ALTER TABLE cuentas ADD COLUMN acepto_datos TEXT;
