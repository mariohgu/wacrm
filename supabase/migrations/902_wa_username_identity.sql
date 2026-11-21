-- ============================================================
-- 902_wa_username_identity.sql
--
-- FORK MIGRATION (900-range: runs after every upstream migration).
-- First shipped as `039b_wa_username_identity.sql`.
--
-- Meta's "WhatsApp usernames" feature lets a customer hide their phone
-- number; the webhook then identifies them by a Business-Scoped User
-- ID (BSUID, e.g. "PE.1128521366369305"). Upstream's migration 040
-- adds `wa_user_id` / `wa_parent_user_id` / `wa_username` and makes
-- the BSUID unique per account, treating the username as display-only.
--
-- This fork observed in production that the BSUID token ROTATES for a
-- returning customer, so deduplicating on it alone still produces a
-- second "new" contact. The one stable signal in the payload is
-- `profile.username` (e.g. "thali.vd_") — the public @handle. This
-- migration makes it a real identity key on top of upstream's columns:
--
--   1. `wa_username_normalized` — generated, lowercased.
--   2. A per-account unique index on it, mirroring migration 022's
--      `phone_normalized` pattern exactly.
--
-- The inbound webhook looks a sender up by username FIRST, then by
-- BSUID, then by phone (see `findOrCreateContact`).
--
-- `merge_contacts()` and `claim_contact_wa_user_id()` live in
-- 906_identity_reconcile.sql.
--
-- Idempotent — safe to run multiple times. The two ADD COLUMNs that
-- overlap upstream's 040 are no-ops when 040 already ran.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_username text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_user_id text;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_username_normalized text
  GENERATED ALWAYS AS (lower(wa_username)) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_wa_username
  ON contacts (account_id, wa_username_normalized)
  WHERE wa_username_normalized IS NOT NULL;
