-- ============================================================
-- 040_transcription_key.sql
--
-- Voice-note transcription for the AI reply assistant (auto-reply +
-- inbox draft) and for human agents (shown in the Inbox under the
-- audio player). See CLAUDE.md's "AI reply assistant" section for the
-- full design: an account on OpenAI or OpenRouter as its main chat
-- provider needs nothing new here — src/lib/ai/config.ts's
-- resolveAuxiliaryEndpoint routes transcription (and embeddings)
-- through that same key automatically, since both providers expose an
-- OpenAI-compatible transcription/embeddings endpoint. These two new
-- columns are only a fallback for an Anthropic-only account, which has
-- neither endpoint natively — same role `embeddings_api_key` already
-- plays (migration 030).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS transcription_api_key text;

-- Free-text model override (e.g. "gpt-4o-transcribe" direct, or
-- "openai/gpt-4o-transcribe" routed through OpenRouter) — not a hard
-- allow-list, model ids churn. Unlike embeddings, transcription output
-- is plain text with no storage-format constraint, so there's no
-- dimension-mismatch risk in letting an account pick a different model.
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS transcription_model text;
