-- ============================================================
-- 040: tighten EXECUTE grants on SECURITY DEFINER functions
--
-- Supabase's Security Advisor (2026-09-16) listed every SECURITY
-- DEFINER function in `public` as callable by signed-in users, and a
-- few as callable by the anonymous role. Postgres grants EXECUTE on a
-- new function to PUBLIC by default, so a function only ever meant for
-- the service-role client (webhook / cron / admin API routes) stays
-- reachable by any logged-in browser session through PostgREST's
-- `/rpc/<name>` unless that default is revoked explicitly — and being
-- SECURITY DEFINER, it then runs as `postgres`, bypassing RLS.
--
-- Everything below is idempotent (REVOKE on a missing privilege and
-- GRANT on an existing one are both no-ops), so it is safe on a
-- database where an earlier draft of a migration left different
-- grants behind.
--
-- Deliberately NOT touched:
--   * `is_account_member(uuid, account_role_enum)` — the RLS helper;
--     policies evaluate it as the querying role, so `authenticated`
--     must keep EXECUTE.
--   * `peek_invitation(text)` — granted to `anon` on purpose (the
--     invite landing page previews an invite before sign-in).
--   * trigger functions (`handle_new_user`, `_bcast_bump`,
--     `broadcast_recipient_aggregate_trigger`,
--     `notify_conversation_assigned`, …) — PostgREST cannot expose a
--     function returning `trigger`, so the linter's row for them is
--     informational only.
-- ============================================================

-- ---- service-role only ------------------------------------------
-- Called exclusively through the service-role admin client from
-- server code; never from a browser session.

-- merge_contacts: deletes a contact after re-pointing its rows. The
-- only caller is POST /api/contacts/[id]/merge, which enforces the
-- admin role + same-account check before invoking it.
REVOKE ALL ON FUNCTION public.merge_contacts(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid) TO service_role;

-- claim_ai_reply_slot: increments a conversation's lifetime auto-reply
-- counter. Migration 029 granted service_role but never revoked the
-- PUBLIC default, so any signed-in user of any account could bump any
-- conversation's counter (and silence its bot) by id.
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;

-- record_webhook_failure: called from the inbound-webhook delivery
-- path (service role). Same missing REVOKE as above.
REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer) TO service_role;

-- one-off dedup sweeps (022 / 036). Already revoked from PUBLIC there;
-- nothing in the app calls them, so no role needs EXECUTE at all.
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;

-- ---- signed-in members only ---------------------------------------
-- Called from the browser / session client; each one derives the
-- caller from auth.uid() and refuses when it is NULL, so `anon` never
-- had a legitimate use. The linter flagged them as "public can
-- execute" because the PUBLIC default (or a re-created function) left
-- `anon` with EXECUTE. Keep `authenticated`; re-grant it explicitly so
-- a function that relied on the PUBLIC default (touch_presence, 024)
-- keeps working after the revoke.
REVOKE ALL ON FUNCTION public.touch_presence(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_presence(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.set_member_role(uuid, account_role_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_role(uuid, account_role_enum) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.remove_account_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_account_member(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.transfer_account_ownership(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.redeem_invitation(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(text) TO authenticated, service_role;
