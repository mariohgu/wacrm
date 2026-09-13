-- ============================================================
-- 040_ai_reply_events.sql — AI auto-reply attempt log
--
-- One row per inbound message the auto-reply bot was asked to handle,
-- recording what happened: it replied, it handed off, it deliberately
-- stood down (cap reached, a human owns the thread, paused here, an
-- automation is active, rate-limited…) or it failed (provider error,
-- send error, config error). Before this existed every one of those
-- paths was a silent `return` — the inbox banner kept saying "AI is
-- replying automatically" while nothing went out, and the only trace
-- was a server log line (or nothing at all for the skip paths).
--
-- Read by:
--   - the inbox banner (GET /api/ai/autoreply/[conversationId]) — the
--     latest event for the open thread + the reply-count vs cap.
--   - Agents → Usage (GET /api/ai/autoreply/events) — the recent
--     account-wide feed, grouped by reason.
--
-- Written exclusively by the service role from the webhook's
-- auto-reply dispatch (src/lib/ai/auto-reply.ts) — there is no INSERT /
-- UPDATE / DELETE policy for `authenticated`. Append-only; prune with a
-- scheduled job if it grows (one row per inbound message on an account
-- with auto-reply on — same order of magnitude as `messages`).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_reply_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  -- The inbound customer message that triggered the attempt. Nullable:
  -- older callers (and unit tests) may not have one in hand.
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- What happened, coarse: 'replied' | 'handoff' | 'skipped' | 'failed'.
  outcome         text NOT NULL CHECK (outcome IN ('replied', 'handoff', 'skipped', 'failed')),
  -- Machine-readable reason code (see AiReplyReason in
  -- src/lib/ai/reply-events.ts). Free text here on purpose — a new
  -- reason code must not need a migration.
  reason          text NOT NULL,
  -- Human-readable detail for failures (provider error message, etc.),
  -- truncated by the writer. Never contains the API key.
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Account feed, newest first (Agents → Usage).
CREATE INDEX IF NOT EXISTS idx_ai_reply_events_account_created
  ON ai_reply_events(account_id, created_at DESC);

-- Latest event for one thread (inbox banner).
CREATE INDEX IF NOT EXISTS idx_ai_reply_events_conversation_created
  ON ai_reply_events(conversation_id, created_at DESC);

ALTER TABLE ai_reply_events ENABLE ROW LEVEL SECURITY;

-- SELECT: any account member — the inbox banner is visible to every
-- role that can open the inbox (viewer+), and the rows carry no
-- billing/credential data (unlike `ai_usage_log`, which is admin+).
DROP POLICY IF EXISTS ai_reply_events_select ON ai_reply_events;
CREATE POLICY ai_reply_events_select ON ai_reply_events FOR SELECT
  USING (is_account_member(account_id));

-- No INSERT/UPDATE/DELETE policies for `authenticated`: written only by
-- the service role from the webhook.

-- Realtime: the inbox banner subscribes to INSERTs on the open
-- conversation so a failure/skip shows up the moment it happens, not on
-- the next thread switch. Same publication pattern as `messages` /
-- `message_reactions` (migrations 001 / 009).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'ai_reply_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ai_reply_events;
  END IF;
END $$;
