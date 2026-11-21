-- ============================================================
-- A_046_cuatro_proveedores.sql — FASE A
--
-- Sustituye, SOLO en esta actualización de producción, a
-- supabase/migrations/046_ai_openai_compatible.sql.
--
-- La 046 de upstream vuelve a crear las restricciones de `provider`
-- con la lista ('openai','anthropic','openai_compatible'). En esta base
-- hay filas con 'openrouter', así que el ADD CONSTRAINT fallaría (y si
-- no fallara, dejaría de poder guardarse OpenRouter). Esta variante es
-- idéntica pero con los CUATRO proveedores, que es además el estado
-- final que deja la migración del fork 900_openrouter_provider.sql.
--
-- Añade la columna base_url (la usa el proveedor "compatible con
-- OpenAI" nuevo). El código actual sigue funcionando igual.
-- Idempotente.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS base_url text;

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'openai_compatible'));

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_openai_compatible_base_url_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_openai_compatible_base_url_check
  CHECK (
    provider <> 'openai_compatible'
    OR (base_url IS NOT NULL AND btrim(base_url) <> '')
  );

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'openai_compatible'));
