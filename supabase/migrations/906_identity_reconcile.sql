-- ============================================================
-- 906_identity_reconcile.sql
--
-- FORK MIGRATION (900-range: runs after every upstream migration).
--
-- Reconciles the fork's contact-identity helpers with the schema
-- upstream shipped in 040 (unique BSUID per account), 036 (one
-- conversation per contact), 052 (`cancelled` flow runs) and 054/059
-- (conversation timestamps). Must run AFTER those.
--
--   1. merge_contacts(survivor, loser) — rewritten. The first version
--      (039b) had three defects against the current schema:
--        a. it re-pointed `conversations.contact_id`, which violates
--           036's UNIQUE (account_id, contact_id) whenever both
--           contacts already have a conversation — the main use case;
--        b. it copied the loser's `wa_username` onto the survivor
--           while the loser still existed → unique violation on
--           idx_contacts_account_wa_username;
--        c. same for `wa_user_id` against 040's unique index.
--      Now: conversations are FOLDED (children re-pointed, loser
--      conversation deleted), and the loser contact is deleted BEFORE
--      its identity is copied onto the survivor.
--
--   2. claim_contact_wa_user_id(account, contact, bsuid) — moves a
--      BSUID onto a contact atomically, releasing it from whichever
--      other contact in the account currently holds it. Used by the
--      inbound webhook when the sender's @username matches contact A
--      but the BSUID is still stamped on a stale duplicate C: the
--      thread stays on A (username wins) and A must own the token so
--      replies are addressable. Returns the previous holder's id (or
--      NULL) so the caller can flag the pair as a possible duplicate.
--
--   3. Drops the fork's old NON-unique index on wa_user_id once
--      upstream's unique one exists (it is then redundant).
--
-- Both functions are SECURITY DEFINER and executable by service_role
-- ONLY. They trust their caller completely: the API route / webhook
-- that invokes them is where tenancy and role checks happen.
--
-- Idempotent — safe to run multiple times.
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
DECLARE
  v_s      contacts%ROWTYPE;
  v_l      contacts%ROWTYPE;
  v_s_conv uuid;
  v_l_conv uuid;
  v_s_last timestamptz;
  v_l_last timestamptz;
BEGIN
  IF p_survivor_id = p_loser_id THEN
    RAISE EXCEPTION 'merge_contacts: survivor and loser must differ';
  END IF;

  -- Lock both rows in a stable order so two concurrent merges of the
  -- same pair cannot deadlock.
  PERFORM 1 FROM contacts
    WHERE id IN (p_survivor_id, p_loser_id)
    ORDER BY id
    FOR UPDATE;

  SELECT * INTO v_s FROM contacts WHERE id = p_survivor_id;
  SELECT * INTO v_l FROM contacts WHERE id = p_loser_id;
  IF v_s.id IS NULL OR v_l.id IS NULL OR v_s.account_id <> v_l.account_id THEN
    RAISE EXCEPTION 'merge_contacts: both contacts must exist in the same account';
  END IF;

  SELECT id INTO v_s_conv FROM conversations
    WHERE account_id = v_s.account_id AND contact_id = v_s.id;
  SELECT id INTO v_l_conv FROM conversations
    WHERE account_id = v_l.account_id AND contact_id = v_l.id;

  -- Which contact heard from the customer most recently — decides
  -- whose BSUID token is the live one (see the identity copy below).
  SELECT max(created_at) INTO v_s_last FROM messages
    WHERE conversation_id = v_s_conv AND sender_type = 'customer';
  SELECT max(created_at) INTO v_l_last FROM messages
    WHERE conversation_id = v_l_conv AND sender_type = 'customer';

  -- ---- conversations -------------------------------------------
  -- 036 guarantees one conversation per (account, contact), so a
  -- plain re-point is only legal when the survivor has none.
  IF v_l_conv IS NOT NULL AND v_s_conv IS NULL THEN
    UPDATE conversations SET contact_id = v_s.id WHERE id = v_l_conv;
  ELSIF v_l_conv IS NOT NULL THEN
    -- Fold the loser's thread into the survivor's — same child-table
    -- breakdown as merge_duplicate_conversations() (036), plus the
    -- fork's ai_reply_events. Re-pointing BEFORE the delete is what
    -- saves the ON DELETE CASCADE children.
    UPDATE messages          SET conversation_id = v_s_conv WHERE conversation_id = v_l_conv;
    UPDATE message_reactions SET conversation_id = v_s_conv WHERE conversation_id = v_l_conv;
    UPDATE deals             SET conversation_id = v_s_conv WHERE conversation_id = v_l_conv;
    UPDATE flow_runs         SET conversation_id = v_s_conv WHERE conversation_id = v_l_conv;
    UPDATE notifications     SET conversation_id = v_s_conv WHERE conversation_id = v_l_conv;
    UPDATE ai_usage_log      SET conversation_id = v_s_conv WHERE conversation_id = v_l_conv;
    UPDATE ai_reply_events   SET conversation_id = v_s_conv WHERE conversation_id = v_l_conv;

    UPDATE conversations c SET
      unread_count      = c.unread_count + lc.unread_count,
      last_message_text = CASE WHEN lm.created_at IS NULL
                               THEN c.last_message_text ELSE lm.content_text END,
      last_message_at   = COALESCE(lm.created_at, c.last_message_at),
      first_inbound_at  = LEAST(c.first_inbound_at, lc.first_inbound_at),
      last_inbound_at   = GREATEST(c.last_inbound_at, lc.last_inbound_at),
      last_reply_at     = GREATEST(c.last_reply_at, lc.last_reply_at),
      updated_at        = now()
    FROM conversations lc
    LEFT JOIN LATERAL (
      SELECT content_text, created_at FROM messages
      WHERE conversation_id = v_s_conv
      ORDER BY created_at DESC
      LIMIT 1
    ) lm ON true
    WHERE c.id = v_s_conv AND lc.id = v_l_conv;

    DELETE FROM conversations WHERE id = v_l_conv;
  END IF;

  -- ---- contact-scoped children ---------------------------------
  -- Plain re-point: no contact-scoped unique constraint on these.
  UPDATE contact_notes                 SET contact_id = v_s.id WHERE contact_id = v_l.id;
  UPDATE deals                         SET contact_id = v_s.id WHERE contact_id = v_l.id;
  UPDATE broadcast_recipients          SET contact_id = v_s.id WHERE contact_id = v_l.id;
  UPDATE automation_logs               SET contact_id = v_s.id WHERE contact_id = v_l.id;
  UPDATE automation_pending_executions SET contact_id = v_s.id WHERE contact_id = v_l.id;
  UPDATE notifications                 SET contact_id = v_s.id WHERE contact_id = v_l.id;

  -- Conflict-guarded re-point for UNIQUE(contact_id, tag_id): move only
  -- tags the survivor doesn't already have, drop the rest.
  UPDATE contact_tags ct SET contact_id = v_s.id
    WHERE ct.contact_id = v_l.id
      AND NOT EXISTS (
        SELECT 1 FROM contact_tags x
        WHERE x.contact_id = v_s.id AND x.tag_id = ct.tag_id
      );
  DELETE FROM contact_tags WHERE contact_id = v_l.id;

  -- Same guard for UNIQUE(contact_id, custom_field_id). Survivor's own
  -- value wins on conflict.
  UPDATE contact_custom_values cv SET contact_id = v_s.id
    WHERE cv.contact_id = v_l.id
      AND NOT EXISTS (
        SELECT 1 FROM contact_custom_values x
        WHERE x.contact_id = v_s.id AND x.custom_field_id = cv.custom_field_id
      );
  DELETE FROM contact_custom_values WHERE contact_id = v_l.id;

  -- flow_runs has a partial UNIQUE on active runs per contact
  -- (idx_one_active_run_per_contact). End the loser's active run
  -- rather than colliding with the survivor's, then keep the history.
  UPDATE flow_runs
    SET status = 'cancelled', ended_at = now(), end_reason = 'contact_merged'
    WHERE contact_id = v_l.id AND status = 'active';
  UPDATE flow_runs SET contact_id = v_s.id WHERE contact_id = v_l.id;

  -- ---- identity ------------------------------------------------
  -- Delete FIRST, copy AFTER: with the loser gone, none of the three
  -- per-account unique indexes (phone_normalized, wa_username_normalized,
  -- wa_user_id) can be tripped by handing its values to the survivor.
  DELETE FROM contacts WHERE id = v_l.id;

  UPDATE contacts SET
    wa_username       = COALESCE(v_s.wa_username, v_l.wa_username),
    wa_parent_user_id = COALESCE(v_s.wa_parent_user_id, v_l.wa_parent_user_id),
    -- The BSUID is a routing token that can rotate: keep the one seen
    -- on the most recent inbound message.
    wa_user_id = CASE
      WHEN v_l.wa_user_id IS NULL THEN v_s.wa_user_id
      WHEN v_s.wa_user_id IS NULL THEN v_l.wa_user_id
      WHEN COALESCE(v_l_last, '-infinity'::timestamptz)
           >= COALESCE(v_s_last, '-infinity'::timestamptz) THEN v_l.wa_user_id
      ELSE v_s.wa_user_id
    END,
    -- A real phone always beats a parked BSUID placeholder (the
    -- pre-2026-11 fork stored "PE.123…" in `phone` for a hidden-number
    -- contact); a placeholder is never carried over.
    phone = CASE
      WHEN v_s.phone <> '' AND v_s.phone !~ '^[A-Za-z]{2}\.' THEN v_s.phone
      WHEN v_l.phone ~ '^[A-Za-z]{2}\.' THEN ''
      ELSE v_l.phone
    END,
    name = COALESCE(NULLIF(v_s.name, ''), v_l.name),
    updated_at = now()
  WHERE id = v_s.id;
END;
$$;

ALTER FUNCTION public.merge_contacts(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_contacts(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(uuid, uuid) TO service_role;

-- ============================================================
-- claim_contact_wa_user_id
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_contact_wa_user_id(
  p_account_id uuid,
  p_contact_id uuid,
  p_wa_user_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev uuid;
BEGIN
  IF p_wa_user_id IS NULL OR btrim(p_wa_user_id) = '' THEN
    RETURN NULL;
  END IF;

  -- Release first, then claim, inside one transaction: the unique
  -- index on (account_id, wa_user_id) is never violated in between.
  WITH released AS (
    UPDATE contacts
      SET wa_user_id = NULL, updated_at = now()
      WHERE account_id = p_account_id
        AND wa_user_id = p_wa_user_id
        AND id <> p_contact_id
      RETURNING id
  )
  SELECT id INTO v_prev FROM released LIMIT 1;

  UPDATE contacts
    SET wa_user_id = p_wa_user_id, updated_at = now()
    WHERE account_id = p_account_id
      AND id = p_contact_id
      AND wa_user_id IS DISTINCT FROM p_wa_user_id;

  RETURN v_prev;
END;
$$;

ALTER FUNCTION public.claim_contact_wa_user_id(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_contact_wa_user_id(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contact_wa_user_id(uuid, uuid, text) TO service_role;

-- ============================================================
-- Drop the fork's old non-unique BSUID index — but only once
-- upstream's unique index (040) is in place, so a database part-way
-- through the 2026-11 production upgrade never loses its only index
-- on the column.
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NOT NULL THEN
    DROP INDEX IF EXISTS public.idx_contacts_wa_user_id;
  END IF;
END
$$;
