-- ============================================================
-- 038_salon_booking.sql — Salon booking API integration
--
-- Lets a Flow automatically register a WhatsApp-originated appointment
-- against an external salon-management system (a separate Laravel API,
-- not part of this repo) instead of a native calendar. wacrm never owns
-- appointment data — it only ever POSTs a "pending" booking to that
-- system's `/citas` endpoint using a generic client/service/staff
-- placeholder (see src/lib/salon-booking/client.ts and the
-- create_salon_appointment Flow node) and lets a human confirm/reassign
-- it there.
--
--   1. `salon_booking_configs` — one row per account, BYO Bearer token
--      (a Laravel Sanctum Personal Access Token) + the base URL and the
--      placeholder ids to send. Same shape as `ai_configs`
--      (029_ai_reply.sql): encrypted secret at rest, admin-managed.
--      Unlike `ai_configs` (member-read, since "is AI on" is something
--      every viewer legitimately needs), this is credential/integration
--      -class data — admin-only read, mirroring the `ai_usage_log`
--      (033_ai_reply_polish.sql) precedent instead.
--
--   2. `flow_nodes.node_type` — add 'create_salon_appointment'. Same
--      drop-and-recreate pattern migration 016 used to add 'send_media'.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. salon_booking_configs
-- ============================================================
CREATE TABLE IF NOT EXISTS salon_booking_configs (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                     uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  base_url                       text NOT NULL,               -- e.g. https://example.com/api/v1/ms (includes their API_BASE_PATH)
  api_token                      text NOT NULL,                -- AES-256-GCM-encrypted Sanctum Personal Access Token
  default_cliente_id             text NOT NULL,
  default_estado_id              text NOT NULL,                -- the "Pendiente" status id in their system
  default_servicio_id            text NOT NULL,
  default_servicio_precio        numeric NOT NULL DEFAULT 0,
  default_servicio_duracion_min  integer NOT NULL DEFAULT 30 CHECK (default_servicio_duracion_min > 0),
  default_staff_id               text,                         -- null = unassigned, matches their "Sin asignar" option
  is_active                      boolean NOT NULL DEFAULT false,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE salon_booking_configs ENABLE ROW LEVEL SECURITY;

-- Credential-bearing (encrypted token + a third-party base URL) —
-- admin-only in every direction, unlike ai_configs' member-read.
DROP POLICY IF EXISTS salon_booking_configs_select ON salon_booking_configs;
CREATE POLICY salon_booking_configs_select ON salon_booking_configs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS salon_booking_configs_insert ON salon_booking_configs;
CREATE POLICY salon_booking_configs_insert ON salon_booking_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS salon_booking_configs_update ON salon_booking_configs;
CREATE POLICY salon_booking_configs_update ON salon_booking_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS salon_booking_configs_delete ON salon_booking_configs;
CREATE POLICY salon_booking_configs_delete ON salon_booking_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_salon_booking_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS salon_booking_configs_updated_at ON salon_booking_configs;
CREATE TRIGGER salon_booking_configs_updated_at
  BEFORE UPDATE ON salon_booking_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_salon_booking_configs_updated_at();

-- ============================================================
-- 2. flow_nodes.node_type — add 'create_salon_appointment'
-- ============================================================
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'create_salon_appointment',
    'end'
  ));
