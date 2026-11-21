-- ============================================================
-- 00_prechecks.sql — SOLO LECTURA. No modifica nada.
--
-- Ejecuta cada bloque por separado en Supabase → SQL Editor y revisa
-- el resultado contra lo que indica el comentario de cada uno ANTES de
-- empezar la Fase A. Ver LEEME.md.
-- ============================================================

-- [1] Proveedores de IA en uso. Si aparece 'openrouter' (es lo normal
--     en esta instalación), la migración 046 de upstream fallaría tal
--     cual: por eso la Fase A usa A_046_cuatro_proveedores.sql.
SELECT 'ai_configs' AS tabla, provider, count(*) FROM ai_configs GROUP BY provider
UNION ALL
SELECT 'ai_usage_log', provider, count(*) FROM ai_usage_log GROUP BY provider
ORDER BY 1, 2;

-- [2] Objetos que la migración 044 da por existentes (les quita
--     permisos). Las seis columnas deben salir con un nombre, NINGUNA
--     en NULL. Si alguna sale NULL, falta una migración antigua
--     (005, 022, 028, 029 o 036): avísame antes de seguir.
SELECT
  to_regprocedure('public._bcast_bump(uuid,text,integer)')        AS bcast_bump_005,
  to_regprocedure('public.recompute_broadcast_counts(uuid)')      AS recompute_counts,
  to_regprocedure('public.claim_ai_reply_slot(uuid,integer)')     AS claim_slot_029,
  to_regprocedure('public.record_webhook_failure(uuid,integer)')  AS webhook_failure_028,
  to_regprocedure('public.merge_duplicate_contacts()')            AS merge_contacts_022,
  to_regprocedure('public.merge_duplicate_conversations()')       AS merge_convs_036;

-- [3] Objetos del fork que ya deberían estar aplicados (migraciones
--     propias, antes llamadas 036_a / 037_a / 039b–039e). Ninguna
--     columna debe salir NULL.
SELECT
  to_regclass('public.salon_booking_configs')                  AS salon_901,
  to_regclass('public.idx_contacts_account_wa_username')       AS username_902,
  to_regprocedure('public.merge_contacts(uuid,uuid)')          AS merge_902,
  to_regclass('public.ai_reply_events')                        AS reply_events_904,
  to_regclass('public.push_subscriptions')                     AS push_905,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'ai_configs'
      AND column_name IN ('transcription_api_key', 'transcription_model')) AS transcripcion_903_debe_ser_2;

-- [4] Una sola conversación por contacto (migración 036). Debe salir
--     con nombre, no NULL — la nueva merge_contacts cuenta con ello.
SELECT to_regclass('public.idx_conversations_account_contact') AS indice_036;

-- [5] INFORMATIVO — contactos con el identificador de WhatsApp (BSUID)
--     guardado en el campo teléfono. Se arreglan en la Fase B; aquí
--     solo es para saber cuántos hay.
SELECT count(*) AS contactos_con_bsuid_en_telefono
FROM contacts
WHERE phone ~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{4,}$';

-- [6] INFORMATIVO — contactos que comparten el mismo identificador
--     (duplicados de la misma persona). También se arreglan en la
--     Fase B.
SELECT account_id, wa_user_id, count(*) AS filas,
       array_agg(name ORDER BY created_at)  AS nombres,
       array_agg(phone ORDER BY created_at) AS telefonos
FROM contacts
WHERE wa_user_id IS NOT NULL
GROUP BY account_id, wa_user_id
HAVING count(*) > 1;

-- [7] INFORMATIVO — plantillas duplicadas (mismo nombre + idioma en la
--     cuenta). La migración 057 (Fase B) BORRA las copias sobrantes,
--     conservando la que está aprobada en Meta. Revisa la lista: si
--     sale vacía, la 057 no borra nada.
SELECT account_id, name, language, count(*) AS copias,
       array_agg(status ORDER BY updated_at DESC) AS estados
FROM message_templates
WHERE language IS NOT NULL
GROUP BY account_id, name, language
HAVING count(*) > 1;
