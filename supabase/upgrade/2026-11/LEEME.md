# Actualización 2026-11: integrar upstream en producción

Guion para llevar a producción la rama `integracion-upstream` (merge de
`ArnasDon/wacrm` hasta el 17-nov-2026 sobre el fork MlennyChatBot).

Todo el SQL se pega en **Supabase → SQL Editor**. Los archivos de
`supabase/migrations/` se pegan tal cual; los de esta carpeta
(`supabase/upgrade/2026-11/`) sustituyen o complementan a algunos de
ellos **solo para esta actualización**.

## Por qué hay un orden obligatorio

**Fase A → desplegar → observar → Fase B.** No se puede cambiar:

- *Código primero* no funciona: el código nuevo necesita columnas y
  funciones que todavía no existen (por ejemplo `ai_configs.base_url`,
  `contacts.wa_parent_user_id`, `flow_runs.transition_seq`). El bot y la
  bandeja fallarían.
- *Todas las migraciones primero* tampoco: dos de ellas rompen el código
  **actual** mientras siga en marcha —
  - el índice único de la 040 hace que se **pierdan mensajes** de
    clientes con número oculto,
  - la 057 hace fallar "Enviar plantilla a Meta".

Por eso la Fase A solo añade cosas (el código actual sigue funcionando
igual) y la Fase B, que endurece reglas y limpia datos, va después de
desplegar.

---

## 0. Antes de empezar

1. **Copia de seguridad.** Supabase → Database → Backups (o
   `pg_dump`). La Fase B fusiona y modifica contactos y no se deshace.
2. **Vercel → Settings → General → Node.js Version: 22.x.** El proyecto
   ahora exige Node ≥ 22.12.
3. Elige un momento de poco movimiento (la Fase A tarda unos minutos).
4. *Muy recomendable:* ensayar la Fase A en un proyecto Supabase
   gratuito restaurando la copia del paso 1. Si no, al menos prueba cada
   archivo así, que no deja nada aplicado:

   ```sql
   BEGIN;
   -- pega aquí el contenido del archivo
   ROLLBACK;
   ```

## 1. Comprobaciones previas

Ejecuta `00_prechecks.sql` bloque a bloque y lee el comentario de cada
uno. No modifica nada. Si los bloques [2], [3] o [4] devuelven algún
`NULL`, **para** y avísame.

## 2. Fase A — migraciones aditivas (con el código actual en marcha)

Pega y ejecuta **en este orden**. Cada línea es un archivo.

| # | Archivo | Carpeta |
|---|---|---|
| 1 | `A_040_solo_columnas.sql` | `supabase/upgrade/2026-11/` — **en lugar de** la 040 |
| 2 | `041_fix_broadcast_contact_id_ambiguity.sql` | `supabase/migrations/` |
| 3 | `042_message_failure_reason.sql` | `supabase/migrations/` |
| 4 | `043_storage_scoped_select.sql` | `supabase/migrations/` |
| 5 | `044_internal_definer_grants.sql` | `supabase/migrations/` |
| 6 | `045_automation_wait_for_reply.sql` | `supabase/migrations/` |
| 7 | `A_046_cuatro_proveedores.sql` | `supabase/upgrade/2026-11/` — **en lugar de** la 046 |
| 8 | `047_account_membership_integrity.sql` | `supabase/migrations/` |
| 9 | `048_quick_reply_content_matches_kind.sql` | `supabase/migrations/` |
| 10 | `049_broadcast_params_jsonb.sql` | `supabase/migrations/` |
| 11 | `051_automation_pending_integrity.sql` | `supabase/migrations/` |
| 12 | `052_flow_run_integrity.sql` | `supabase/migrations/` |
| 13 | `053_ai_reply_integrity.sql` | `supabase/migrations/` |
| 14 | `054_webhook_status_integrity.sql` | `supabase/migrations/` |
| 15 | `055_authz_membership_holes.sql` | `supabase/migrations/` |
| 16 | `058_engine_race_gaps.sql` | `supabase/migrations/` |
| 17 | `059_dashboard_overview.sql` | `supabase/migrations/` |
| 18 | `060_inbound_unsupported_reason.sql` | `supabase/migrations/` |
| 19 | `906_identity_reconcile.sql` | `supabase/migrations/` (fork) |
| 20 | `907_redeem_invitation_fork_tables.sql` | `supabase/migrations/` (fork) |

Notas:

- **No** ejecutes en esta fase `040_…`, `046_…` ni `057_…` de
  `supabase/migrations/`.
- No existen la 050 ni la 056 (upstream se saltó esos números).
- **No** hace falta volver a ejecutar 900–905: son tus migraciones de
  siempre con nombre nuevo (antes `036_a`, `037_a`, `039b`–`039e`) y ya
  están aplicadas. Tampoco las antiguas 001–039 aunque upstream las haya
  retocado (solo cambió `uuid_generate_v4()` por `gen_random_uuid()`).
- La 054 borra reacciones de agente duplicadas sobre un mismo mensaje
  (deja la más reciente). Es intencionado.
- Si un archivo da error, **para ahí**; nada posterior depende de
  "saltárselo". Copia el mensaje y lo vemos.
- Al terminar, ejecuta una vez:

  ```sql
  NOTIFY pgrst, 'reload schema';
  ```

Con la Fase A aplicada y el código antiguo aún desplegado todo sigue
funcionando. Dos diferencias menores hasta que despliegues: si una
persona toma un chat mientras el bot redacta, el aviso dirá "límite
alcanzado" en vez de "tomado por una persona"; y dos agentes no podrán
reaccionar a la vez al mismo mensaje.

## 3. Desplegar el código

1. Sube la rama: `git push -u origin integracion-upstream`. Vercel crea
   un *preview*; ábrelo, entra y da una vuelta (bandeja, contactos,
   ajustes). Los webhooks de WhatsApp siguen llegando a producción, así
   que ahí no verás mensajes nuevos entrar.
2. Si todo se ve bien, pasa la rama a `main` y súbela:

   ```
   git switch main
   git merge --ff-only integracion-upstream
   git push origin main
   ```

3. En Supabase → Authentication → URL Configuration → **Redirect URLs**
   añade `https://TU-DOMINIO/auth/callback` (los correos de confirmación
   y de recuperar contraseña ahora pasan por ahí; ver
   `docs/auth-emails.md`).

## 4. Observación (24–48 h)

Recorre la lista de comprobación de más abajo. Durante esta ventana, si
algo va mal, **Vercel → Deployments → Instant Rollback** al despliegue
anterior es seguro (el código antiguo funciona con el esquema de la
Fase A). Única salvedad: un cliente con número oculto que escriba **por
primera vez** durante la ventana puede quedar duplicado tras el
rollback; se arregla con "Fusionar con otro contacto".

## 5. Fase B — endurecer y limpiar (ya sin vuelta atrás)

Solo cuando estés conforme con el paso 4. En este orden:

| # | Archivo | Qué hace |
|---|---|---|
| 1 | `supabase/migrations/057_message_templates_account_unique.sql` | Una plantilla por nombre+idioma en la cuenta. **Borra copias duplicadas** (mira antes el bloque [7] de `00_prechecks.sql`). |
| 2 | `B1_duplicados.sql` | Lista contactos repetidos y te da la sentencia para fusionar cada pareja. Repite hasta que no devuelva filas. |
| 3 | `B2_mover_bsuid_aparcados.sql` | Saca el identificador de WhatsApp del campo teléfono de los contactos antiguos. |
| 4 | `B3_indice_unico.sql` | Crea el índice único (lo que faltaba de la 040). Se niega a continuar si quedan duplicados. |

Después de la Fase B repite los puntos 5, 6 y 7 de la lista.

---

## Lista de comprobación manual

1. **IA / OpenRouter** — Agentes → Configuración muestra OpenRouter y tu
   modelo; "Probar clave" funciona; Playground responde; el botón de
   borrador en la bandeja responde.
2. **Nota de voz** — envía un audio como cliente: aparece la
   transcripción y el bot la contesta.
3. **Base de conocimiento** — añade un documento, "Reindexar", pregunta
   algo que solo responde ese documento.
4. **Respuesta automática** — al escribir aparece "escribiendo…" y luego
   la respuesta; tres mensajes seguidos producen una sola respuesta;
   una derivación envía la despedida, pausa el bot y asigna al agente;
   el aviso sobre el hilo explica cada caso.
5. **Número oculto** — un cliente con número oculto vuelve a escribir:
   cae en el mismo hilo y conserva el nombre que le pusiste.
6. **Responderle** — texto, imagen, plantilla, reacción, un paso de
   flujo y el bot. En pantalla se ve `@usuario` (nunca `PE.…`) y puedes
   editar su nombre desde la ficha.
7. **Fusionar contactos** — fusiona dos contactos que ya tengan
   conversación: queda un solo hilo con todos los mensajes.
8. **Reserva de salón** — recorre el flujo de punta a punta; la cita
   llega al sistema del salón.
9. **App instalada** — abre en la bandeja; en modo avión muestra la
   página "Sin conexión"; tras un despliegue aparece el aviso de nueva
   versión.
10. **Push e insignia** — Ajustes → Notificaciones push → "Enviar
    prueba"; con la app cerrada, un mensaje nuevo da **un solo** aviso y
    sube la insignia.
11. **Navegación** — barra inferior en el móvil; iniciar sesión,
    registrarse, recuperar contraseña y aceptar una invitación llevan a
    la bandeja; no se ven textos tipo `Namespace.clave`.
12. **Composer** — texto, adjuntos, voz, respuestas rápidas y
    plantillas; en el móvil Enter hace salto de línea.
13. **Regresión** — envía una difusión; envía una plantilla a Meta
    (después de la 057); un mensaje fallido muestra el motivo de Meta.

## Si algo falla

- Un RPC responde `PGRST202` (función no encontrada): ejecuta
  `NOTIFY pgrst, 'reload schema';`.
- El bot no contesta: Agentes → Uso → "Actividad de respuestas
  automáticas" dice el motivo de cada intento.
- Un push no llega: Ajustes → Notificaciones push → Diagnóstico →
  "Copiar resultado".
