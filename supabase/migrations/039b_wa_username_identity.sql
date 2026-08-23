-- ============================================================
-- 040_wa_username_identity.sql
--
-- Meta's "WhatsApp usernames" feature lets a customer hide their phone
-- number; the webhook then identifies them by a rotating Business-
-- Scoped User ID (BSUID, e.g. "PE.1128521366369305") instead — see
-- migrations 038/039-era session notes and the "WhatsApp contact
-- identity" section in CLAUDE.md. Deduplicating purely on that token
-- (the prior stopgap) breaks once it rotates: the same real customer
-- ends up as a second "new" contact.
--
-- The one truly stable signal in the payload is `profile.username`
-- (e.g. "thali.vd_") — the customer's public @handle. It is not their
-- name, but it IS a durable identity key. This migration:
--
--   1. Adds `wa_username` (+ a generated, case-insensitive
--      `wa_username_normalized`) and `wa_user_id` (the current/last-
--      known BSUID, kept for a later outbound-sending fix — NOT used
--      for dedup since it can rotate) to `contacts`.
--   2. Adds a per-account unique index on the normalized username,
--      mirroring migration 022's `phone_normalized` pattern exactly.
--   3. Adds `merge_contacts(survivor, loser)` — an explicit-id sibling
--      of `merge_duplicate_contacts()` (022), for staff to manually
--      collapse a BSUID-only contact into an existing phone contact
--      once they've linked the same customer's username onto it (or
--      for any other accidental duplicate pair).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1 & 2. wa_username / wa_user_id + unique index
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_username text;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_username_normalized text
  GENERATED ALWAYS AS (lower(wa_username)) STORED;

-- Current/last-known BSUID routing token. Not unique (it can rotate,
-- and two rows could transiently share a stale value) — plain index
-- only, for lookup performance in the legacy fallback path.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_user_id text;
CREATE INDEX IF NOT EXISTS idx_contacts_wa_user_id ON contacts (wa_user_id)
  WHERE wa_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_wa_username
  ON contacts (account_id, wa_username_normalized)
  WHERE wa_username_normalized IS NOT NULL;

-- ============================================================
-- 3. merge_contacts(survivor, loser) — explicit-id contact merge.
--
-- Same child-table re-pointing breakdown as merge_duplicate_contacts()
-- (022): plain re-point where the child has no contact-scoped unique
-- constraint, conflict-guarded re-point where it does
-- (contact_tags/contact_custom_values), and the active-flow-run
-- exception. Differs only in how the pair is chosen: here the caller
-- supplies both ids explicitly (driven by a staff action in the UI)
-- rather than an automatic GROUP BY phone_normalized scan.
--
-- SECURITY DEFINER so it can re-point rows across tables regardless of
-- RLS. EXECUTE is granted to service_role ONLY (see the GRANT below,
-- mirroring migration 029's claim_ai_reply_slot) — this is NOT callable
-- from the browser client. The API route that invokes it runs under
-- the service-role admin client and must itself enforce admin-role +
-- that both ids belong to the caller's own account before calling it;
-- this function trusts its caller completely and does no tenancy check
-- of its own.
-- ============================================================
CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_survivor_id uuid,
  p_loser_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_survivor_id = p_loser_id THEN
    RAISE EXCEPTION 'merge_contacts: survivor and loser must differ';
  END IF;

  -- Plain re-point: no contact-scoped unique constraint on these.
  UPDATE conversations                 SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE contact_notes                 SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE deals                         SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE broadcast_recipients          SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE automation_logs               SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;
  UPDATE automation_pending_executions SET contact_id = p_survivor_id WHERE contact_id = p_loser_id;

  -- Conflict-guarded re-point for UNIQUE(contact_id, tag_id): move only
  -- tags the survivor doesn't already have, drop the rest.
  UPDATE contact_tags ct SET contact_id = p_survivor_id
    WHERE ct.contact_id = p_loser_id
      AND NOT EXISTS (
        SELECT 1 FROM contact_tags s
        WHERE s.contact_id = p_survivor_id AND s.tag_id = ct.tag_id
      );
  DELETE FROM contact_tags WHERE contact_id = p_loser_id;

  -- Same guard for UNIQUE(contact_id, custom_field_id). Survivor's own
  -- value wins on conflict.
  UPDATE contact_custom_values cv SET contact_id = p_survivor_id
    WHERE cv.contact_id = p_loser_id
      AND NOT EXISTS (
        SELECT 1 FROM contact_custom_values s
        WHERE s.contact_id = p_survivor_id AND s.custom_field_id = cv.custom_field_id
      );
  DELETE FROM contact_custom_values WHERE contact_id = p_loser_id;

  -- flow_runs has a partial UNIQUE on active runs per contact.
  -- Re-point only non-active runs; an active loser run is left to be
  -- NULLed by its FK's ON DELETE SET NULL when the loser is removed
  -- below, avoiding a collision with the survivor's own active run.
  UPDATE flow_runs SET contact_id = p_survivor_id
    WHERE contact_id = p_loser_id AND status <> 'active';

  -- If the loser has identity data the survivor is missing, carry it
  -- over rather than losing it — e.g. a wa_username linked on the
  -- loser but not yet on the survivor.
  UPDATE contacts s
  SET
    wa_username = COALESCE(s.wa_username, l.wa_username),
    wa_user_id  = COALESCE(l.wa_user_id, s.wa_user_id) -- prefer the loser's if present: it's likely the more recent token
  FROM contacts l
  WHERE s.id = p_survivor_id AND l.id = p_loser_id;

  DELETE FROM contacts WHERE id = p_loser_id;
END;
$$;

ALTER FUNCTION public.merge_contacts(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_contacts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid) TO service_role;
