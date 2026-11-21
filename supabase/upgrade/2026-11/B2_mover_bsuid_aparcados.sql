-- ============================================================
-- B2_mover_bsuid_aparcados.sql — FASE B, paso 2
--
-- Ejecutar SOLO cuando B1_duplicados.sql ya no devuelve filas.
--
-- Antes de esta actualización el fork guardaba el identificador de
-- WhatsApp (BSUID, p. ej. "PE.1128521366369305") en el campo teléfono
-- de los contactos con número oculto, porque `phone` no admite NULL.
-- Upstream usa otra convención: teléfono vacío ('') y el identificador
-- en `wa_user_id`. Este script pasa los contactos antiguos a esa
-- convención.
--
-- - El identificador pasa a wa_user_id (si ese campo ya tiene uno más
--   reciente, se respeta el más reciente).
-- - El teléfono queda vacío. En pantalla se seguirá viendo "@usuario"
--   o "número oculto", igual que hoy.
-- - Si el NOMBRE del contacto era el propio identificador, se cambia
--   por el @usuario cuando lo hay.
-- - No toca contactos con teléfono real.
--
-- Es seguro repetirlo: la segunda vez no encuentra nada que cambiar.
-- ============================================================

UPDATE contacts p
SET
  wa_user_id = COALESCE(p.wa_user_id, p.phone),
  name       = CASE
                 WHEN p.name = p.phone THEN COALESCE(p.wa_username, p.name)
                 ELSE p.name
               END,
  phone      = '',
  updated_at = now()
WHERE p.phone ~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{4,}$'
  -- Red de seguridad: nunca crear un duplicado de identificador. Si
  -- esta condición deja fuera alguna fila es que B1 aún tiene trabajo.
  AND NOT EXISTS (
    SELECT 1 FROM contacts o
    WHERE o.account_id = p.account_id
      AND o.id <> p.id
      AND o.wa_user_id = COALESCE(p.wa_user_id, p.phone)
  );

-- Comprobación: debe devolver 0. Si no, vuelve a B1_duplicados.sql.
SELECT count(*) AS quedan_bsuid_en_telefono
FROM contacts
WHERE phone ~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{4,}$';
