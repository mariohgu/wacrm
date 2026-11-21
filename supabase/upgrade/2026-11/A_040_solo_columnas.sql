-- ============================================================
-- A_040_solo_columnas.sql — FASE A (antes de desplegar el código nuevo)
--
-- Sustituye, SOLO en esta actualización de producción, a
-- supabase/migrations/040_contact_business_scoped_user_id.sql.
--
-- Es la 040 de upstream SIN su índice único sobre wa_user_id. Ese
-- índice se crea en la Fase B (B3_indice_unico.sql), después de
-- desplegar y de limpiar los duplicados, por dos motivos:
--
--   1. Si hoy existen dos contactos con el mismo wa_user_id (el fork lo
--      permitía a propósito), el CREATE UNIQUE INDEX fallaría.
--   2. Con el índice puesto y el código VIEJO todavía en marcha, un
--      cliente que oculta su número provocaría un choque de unicidad al
--      intentar crear el contacto y el mensaje se perdería (el webhook
--      ya respondió 200 a Meta, que no reintenta).
--
-- Solo añade columnas: el código actual sigue funcionando igual.
-- Idempotente.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_user_id TEXT,
  ADD COLUMN IF NOT EXISTS wa_parent_user_id TEXT,
  ADD COLUMN IF NOT EXISTS wa_username TEXT;

COMMENT ON COLUMN contacts.wa_user_id IS
  'WhatsApp business-scoped user ID (e.g. "US.13491208655302741918"). Routing token Meta sends when it withholds the phone number. Unique per account (upstream 040); this fork has seen it rotate, so the username is looked up first.';
COMMENT ON COLUMN contacts.wa_parent_user_id IS
  'Portfolio-level BSUID (e.g. "US.ENT.11815799212886844830"). Stored for reference; not used as a lookup key.';
COMMENT ON COLUMN contacts.wa_username IS
  'WhatsApp username, without the leading @. In this fork it is ALSO an identity key (wa_username_normalized, unique per account — fork migration 902).';
