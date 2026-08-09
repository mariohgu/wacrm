-- ============================================================
-- 037_add_openrouter_provider.sql — allow 'openrouter' as an AI provider
--
-- Adds OpenRouter as a third BYO-key option alongside OpenAI and
-- Anthropic (see src/lib/ai/providers/openrouter.ts). Both tables that
-- CHECK-constrain the provider column need their constraint widened;
-- the constraint names below are Postgres's default auto-generated
-- names for an inline column CHECK (`<table>_<column>_check`), matching
-- how they were created in 029_ai_reply.sql / 033_ai_reply_polish.sql.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));
