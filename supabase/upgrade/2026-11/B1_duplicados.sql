-- ============================================================
-- B1_duplicados.sql — FASE B, paso 1 (DESPUÉS de desplegar el código
-- nuevo y de haber aplicado 906 en la Fase A).
--
-- Encuentra contactos que son la misma persona de WhatsApp repetida:
-- comparten el mismo identificador (BSUID), ya esté en wa_user_id o
-- "aparcado" en el campo teléfono (así lo guardaba el fork antes de
-- esta actualización).
--
-- Esta consulta NO modifica nada. Devuelve, por cada duplicado, la
-- sentencia que lo fusiona en la columna `ejecutar`:
--
--   se_conserva  → el contacto que queda (el que tiene teléfono real;
--                  si ninguno lo tiene, el que tiene @usuario; si no,
--                  el más antiguo)
--   se_absorbe   → el que desaparece; sus conversaciones, mensajes,
--                  notas, etiquetas y tratos pasan al que se conserva
--
-- QUÉ HACER:
--   1. Ejecuta esta consulta.
--   2. Si no devuelve filas → no hay duplicados; pasa a B2.
--   3. Si devuelve filas, revisa que cada pareja sea de verdad la misma
--      persona. Copia el texto de la columna `ejecutar` de cada fila y
--      ejecútalo (una fila = una sentencia). Si en alguna pareja
--      prefieres conservar el otro contacto, intercambia los dos ids.
--   4. Vuelve a ejecutar esta consulta hasta que no devuelva filas.
--
-- La fusión no se puede deshacer (por eso la copia de seguridad del
-- paso 0 de LEEME.md).
-- ============================================================

WITH tokens AS (
  SELECT
    id, account_id, name, phone, wa_username, created_at,
    COALESCE(
      wa_user_id,
      CASE WHEN phone ~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{4,}$' THEN phone END
    ) AS token
  FROM contacts
),
ranked AS (
  SELECT
    *,
    row_number() OVER (
      PARTITION BY account_id, token
      ORDER BY
        (phone <> '' AND phone !~ '^[A-Za-z]{2}\.') DESC,  -- teléfono real primero
        (wa_username IS NOT NULL) DESC,                     -- luego el que tiene @usuario
        created_at ASC,                                     -- luego el más antiguo
        id
    ) AS puesto
  FROM tokens
  WHERE token IS NOT NULL
)
SELECT
  format('SELECT merge_contacts(%L, %L);', s.id, l.id) AS ejecutar,
  s.name        AS se_conserva,
  s.phone       AS telefono_que_queda,
  s.wa_username AS usuario_que_queda,
  l.name        AS se_absorbe,
  l.phone       AS telefono_absorbido,
  l.wa_username AS usuario_absorbido,
  s.token       AS identificador_compartido
FROM ranked l
JOIN ranked s
  ON s.account_id = l.account_id
 AND s.token = l.token
 AND s.puesto = 1
WHERE l.puesto > 1
ORDER BY s.token, l.puesto;
