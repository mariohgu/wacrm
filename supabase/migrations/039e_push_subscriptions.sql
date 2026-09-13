-- 040_push_subscriptions.sql
--
-- Web Push subscriptions for the installed PWA: one row per
-- (user, browser/device). A user with the app on their phone and
-- their laptop has two rows and both get pushed.
--
-- The endpoint is the push service's per-subscription URL and is
-- globally unique by construction, so it doubles as the natural key
-- (the client upserts on it when it re-subscribes).
--
-- Rows are written by the signed-in user through
-- POST /api/push/subscriptions (RLS below) and pruned by the sender
-- (src/lib/push/send.ts, service role) when the push service answers
-- 404/410 — the subscription was revoked or expired.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account
  ON push_subscriptions(account_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- A user sees and manages only their own devices. The insert check
-- also pins account_id to an account the user actually belongs to, so
-- a crafted direct insert can't register a device under someone
-- else's account.
DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subscriptions_insert ON push_subscriptions;
CREATE POLICY push_subscriptions_insert ON push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id AND is_account_member(account_id));

DROP POLICY IF EXISTS push_subscriptions_update ON push_subscriptions;
CREATE POLICY push_subscriptions_update ON push_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND is_account_member(account_id));

DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;
CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE push_subscriptions IS
  'Web Push subscriptions, one per user device. Written via /api/push/subscriptions; pruned by the server sender on 404/410.';
