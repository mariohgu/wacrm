-- ============================================================
-- B3_indice_unico.sql — FASE B, paso 3 (último)
--
-- Crea la garantía que upstream añadió en su migración 040 y que la
-- Fase A dejó pendiente: un solo contacto por identificador de
-- WhatsApp (BSUID) en cada cuenta.
--
-- El bloque comprueba primero que no queden duplicados ni
-- identificadores en el campo teléfono; si queda alguno, se detiene
-- con un mensaje y NO cambia nada (vuelve a B1 / B2).
--
-- Después de este paso ya no es seguro volver al código anterior a la
-- actualización.
-- ============================================================

DO $$
DECLARE
  v_dupes  integer;
  v_parked integer;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM contacts
    WHERE wa_user_id IS NOT NULL
    GROUP BY account_id, wa_user_id
    HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'Quedan % identificadores de WhatsApp repetidos. Ejecuta B1_duplicados.sql y fusiona esas parejas antes de continuar.',
      v_dupes;
  END IF;

  SELECT count(*) INTO v_parked FROM contacts
  WHERE phone ~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{4,}$';
  IF v_parked > 0 THEN
    RAISE EXCEPTION
      'Quedan % contactos con el identificador en el campo teléfono. Ejecuta B1_duplicados.sql y luego B2_mover_bsuid_aparcados.sql.',
      v_parked;
  END IF;
END
$$;

-- Idéntico al de supabase/migrations/040_contact_business_scoped_user_id.sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_wa_user_id
  ON contacts (account_id, wa_user_id)
  WHERE wa_user_id IS NOT NULL;

-- El índice no único que usaba el fork queda redundante.
DROP INDEX IF EXISTS public.idx_contacts_wa_user_id;

-- Comprobación final: la columna debe salir con nombre, no NULL.
SELECT to_regclass('public.idx_contacts_account_wa_user_id') AS indice_unico_creado;
