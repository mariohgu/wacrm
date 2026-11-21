-- ============================================================
-- 900_openrouter_provider.sql — allow 'openrouter' as an AI provider
--
-- FORK MIGRATION (900-range: always runs after every upstream
-- migration and can never collide with an upstream number).
--
-- Adds OpenRouter as a BYO-key option alongside OpenAI, Anthropic and
-- upstream's 'openai_compatible' (046) — see
-- src/lib/ai/providers/openrouter.ts. Both tables that CHECK-constrain
-- the provider column need their constraint widened.
--
-- This file MUST list every provider the app knows about, upstream's
-- included: it runs AFTER 046_ai_openai_compatible.sql, so a narrower
-- list here would silently remove 'openai_compatible' again. When
-- upstream adds a provider in a later migration, add it here too.
--
-- History: first shipped as `036_a_add_openrouter_provider.sql` with a
-- three-value list (before upstream's 046 existed). A database that
-- applied that version needs nothing from this file on its own — the
-- production upgrade applies the four-value constraint through
-- supabase/upgrade/2026-11/A_046_cuatro_proveedores.sql.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'openai_compatible'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'openai_compatible'));
