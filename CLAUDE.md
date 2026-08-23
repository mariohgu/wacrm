@AGENTS.md

# Project context

**wacrm** — self-hostable WhatsApp CRM template. Next.js 16 (App Router) +
Supabase. Fork-friendly template repo (see [CONTRIBUTING.md](CONTRIBUTING.md)):
forkers customize freely; upstream (`ArnasDon/wacrm`) only wants security
fixes, correctness bugs, and small polish back.

## Stack

- Next.js 16.2.12, React 19, TypeScript
- Supabase (Postgres + Auth), SQL migrations in `supabase/migrations/`
  (numbered, sequential, idempotent — see any file for the pattern)
- Tailwind + shadcn/ui (`components.json`)
- `next-intl` for i18n — `messages/en.json` + `messages/ko.json` + `messages/es.json`
- Vitest for tests, ESLint + Prettier
- `mcp-server/` — a separate npm package exposing the CRM over MCP
  (own `package.json`/deps, not installed at repo root — expect
  `tsc`/`next build` to report module-not-found errors under
  `mcp-server/` unless its own deps are installed; unrelated to app code)

## Feature modules (`src/app/(dashboard)/`)

`inbox` (shared WhatsApp inbox), `contacts`, `pipelines` (sales),
`broadcasts`, `automations`/`flows` (no-code), `agents` (AI assistant
config/playground/usage), `settings`, `notifications`, `dashboard`.

## i18n / locales

Single build-time locale, not a per-user runtime switcher. `src/i18n/request.ts`
reads `NEXT_PUBLIC_APP_LOCALE` (set in `.env.local`/`docker-compose.yml`/
`Dockerfile`, default `en`) and dynamically `import`s `messages/${locale}.json`;
an unknown/missing locale file falls back to `messages/en.json` at the whole-file
level — there is no per-key fallback, so a key present in `en.json` but missing
from another locale renders as the raw `"Namespace.key"` string at runtime (see
the `Automations.builder.delete` bug in the change log below for a concrete
example of this failure mode).

`en.json` is the source of truth. `src/i18n/messages.test.ts` enforces parity
for every locale listed in its `TRANSLATED_LOCALES` array (currently `['ko',
'es']`): every `en.json` key must exist in each translated file, and each
translated file must have no orphaned keys absent from `en.json`. Run
`npx vitest run src/i18n/messages.test.ts` after touching any locale file —
adding a new key to `en.json` without updating `ko.json`/`es.json` fails it
immediately, which is much faster feedback than finding a raw key string in
the UI later.

## AI reply assistant (`src/lib/ai/`)

Bring-your-own-key LLM integration powering AI-drafted replies (inbox),
the auto-reply bot, and the Agents → Playground tab. No LLM SDK
dependency — every provider is a plain `fetch` adapter under
`src/lib/ai/providers/`.

- `types.ts` — `AiProvider` union (source of truth for supported
  providers) + shared `AiConfig`/`ChatMessage`/`AiError` types
- `defaults.ts` — `AI_PROVIDER_DEFAULT_MODEL` per-provider default model
  (free text in the UI, not an allow-list — model IDs churn)
- `config.ts` — `loadAiConfig` reads + decrypts the account's row from
  `ai_configs` (AES-256-GCM at rest via `src/lib/whatsapp/encryption.ts`)
- `generate.ts` — `generateReply` dispatches to the right provider
  adapter by `config.provider`, then strips the `[[HANDOFF]]` sentinel
- `providers/{openai,anthropic,openrouter}.ts` — one adapter per
  provider; `providers/shared.ts` has the cross-provider helpers
  (usage normalization, HTTP/network error mapping, turn merging)
- `embeddings.ts` — separate, OpenAI-only (no Anthropic/OpenRouter
  embeddings API), optional semantic KB search
- UI: `src/components/settings/ai-config.tsx` (provider/model/key form),
  `src/components/agents/ai-playground.tsx`, `ai-usage.tsx`
- API: `src/app/api/ai/config/route.ts` (save/load, validates key with
  the provider before persisting), `src/app/api/ai/test/route.ts`
  ("Test key" button), `src/app/api/ai/draft/route.ts` (inbox draft)
- DB: `ai_configs` (per-account config + encrypted key,
  `supabase/migrations/029_ai_reply.sql`), `ai_usage_log` (token spend,
  `033_ai_reply_polish.sql`) — both CHECK-constrain `provider`, so a new
  provider needs a migration widening both constraints, not just app code

Adding a provider = extend `AiProvider` (`types.ts`), add a default
model (`defaults.ts`), add a `providers/<name>.ts` adapter (OpenAI-shaped
providers can mostly clone `providers/openai.ts`), wire the `case` in
`generate.ts`, extend the two manual validation checks (`api/ai/config`
+ `api/ai/test` — no zod in this repo, checks are hand-rolled), add the
UI label/placeholder/`<SelectItem>` in `ai-config.tsx`, and widen both
DB CHECK constraints in a new migration.

**Auto-reply handoff can carry a customer-facing message.** The model
may pair the `[[HANDOFF]]` sentinel with a short message (the
`buildSystemPrompt` scaffold, `defaults.ts`, explicitly allows this —
"You may put a short, warm sentence... before the sentinel"). When it
does, `dispatchInboundToAiReply` (`auto-reply.ts`) sends that message to
the customer — gated by the same atomic `claim_ai_reply_slot` RPC as a
normal reply, wrapped in its own try/catch so a send failure never skips
the handoff bookkeeping (`ai_autoreply_disabled`, `ai_handoff_summary`)
below it. Before this, the handoff branch discarded any model text
outright and the customer got silence.

## Automations builder (`src/components/automations/automation-builder.tsx`)

One 1700+ line file, no external flow library (that's the *separate*
`Flows` feature under `src/components/flows/`, which does use
`@xyflow/react` + `@dagrejs/dagre` — don't confuse the two). Steps are a
plain nested tree, `BuilderStep[]`, where a `condition` step carries
`branches: { yes: BuilderStep[]; no: BuilderStep[] }`.

- `StepList` → `StepRenderer` (one per node) → `ConditionBranches` (only
  for `step_type === "condition"`, renders two nested `StepList`s for
  `branches.yes`/`branches.no`) → `StepEditor` (per-type config form,
  e.g. the `send_message` "Message text" textarea)
- A `StepPath` (array of `{kind:"root",index}` / `{kind:"branch",
  parentCid,branch,index}` segments, one per tree level) is how
  `updateStep`/`deleteStepAt`/`moveStepAt` (in `AutomationBuilder`)
  locate a node inside `state.steps` via `mapAtPath`/`removeAt`/`moveAt`
  — each walks one `StepPath` segment per recursion level, so the
  segment count **must** equal tree depth, root steps included
- `ConditionBranches` passes its children a `parentPath` that already
  ends with a branch-marker segment (placeholder `index: 0`, see the
  comment at its `yesPath`/`noPath` construction) — `StepRenderer` is
  expected to *replace* that trailing placeholder with the child's real
  index, not append a new segment on top of it (this was a real bug,
  fixed 2026-08-02 — see change log below)
- `next-intl` v4's translator function has **no `defaultValue` option**
  (that's an i18next-ism) — a missing message key renders the raw
  `"Namespace.key"` string regardless of a second-arg `{ defaultValue }`
  passed at the call site. `automation-builder.tsx` has two such calls
  (`t("delete", {defaultValue:...})`, `t("config.closeConversationHint",
  {defaultValue:...})`); treat that pattern as a footgun, not a working
  fallback — the key must actually exist in `messages/*.json`

## Salon booking (external API, via Flows)

WhatsApp-originated appointment booking does **not** use Google Calendar
or a native calendar entity — this fork integrates with a separate,
already-existing salon-management system (a Laravel + Sanctum backend
with its own `/citas` REST API, source of truth for appointments). wacrm
only ever POSTs a pending booking to it.

- **Motor**: the conversational (multi-turn) part lives in **Flows**,
  not Automations — Automations' engine (`src/lib/automations/engine.ts`)
  has no primitive to suspend a run across separate inbound WhatsApp
  messages, so it can't hold "what day? → wait → what time? → wait."
  Flows' `flow_runs` DB row (`current_node_key`, `vars`) already is that
  state machine; `collect_input` is the "ask and wait" node reused here.
- **Credentials**: `salon_booking_configs` (one row per account,
  `supabase/migrations/038_salon_booking.sql`) — a **static Sanctum
  Personal Access Token** (Bearer), not OAuth. Encrypted with the same
  `src/lib/whatsapp/encryption.ts` `encrypt`/`decrypt` used for
  `whatsapp_config`/`ai_configs` (imported cross-module as-is, never
  relocated). Admin-only RLS in both directions (credential-bearing,
  unlike `ai_configs`' member-read) — mirrors the `ai_usage_log`
  precedent instead.
- **"Generic booking" strategy** (by design, not a limitation to fix
  later): wacrm never tries to resolve the WhatsApp contact to a real
  salon client/service/staff record — no such lookup endpoint is assumed
  to exist. Every booking uses admin-configured placeholder ids
  (`default_cliente_id`/`default_estado_id`/`default_servicio_id`,
  optionally `default_staff_id`), `origen_reserva: "whatsapp"`,
  `requiere_confirmacion: true`, and a `notas_cliente` string **built
  automatically** by the node executor (contact name/phone + requested
  date/time + any extra captured vars) — never a hand-written template.
  The appointment lands as "pending" for a human to confirm/reassign.
- **New Flow node type**: `create_salon_appointment`
  (`src/lib/flows/types.ts` → `CreateSalonAppointmentNodeConfig`).
  Auto-advancing (does I/O, doesn't wait on the customer). Parses its
  two input vars **strictly** against fixed `dd/MM/yyyy` / `HH:mm`
  formats via `date-fns` (`parseSalonDateTime`, exported from
  `src/lib/flows/engine.ts` for unit testing) — there's no AI/NLP date
  parsing, so the preceding `collect_input` prompts must state the
  expected format explicitly. Two outgoing edges: `next_node_key`
  (success) and `error_next_node_key` (missing config / unparseable
  date-time / salon API error) — on error with no `error_next_node_key`
  set, the run ends `failed` rather than silently continuing as if
  booked.
- **REST client**: `src/lib/salon-booking/client.ts` — plain `fetch`,
  no SDK (same style as `src/lib/whatsapp/meta-api.ts` /
  `src/lib/ai/providers/*`). `createAppointment()` POSTs `/citas`;
  `testConnection()` GETs it (no side effect) for the settings panel's
  "Test connection" button. No token refresh logic needed — the Sanctum
  PAT is long-lived, unlike an OAuth access token.
- **Adding this node type touched the same ~10-file set** every prior
  Flows node type addition has (see the `send_media` precedent):
  `types.ts`, `engine.ts`, `validate.ts` (+ `outgoingEdges`),
  `components/flows/shared.tsx` (its own **duplicated** `NodeType`
  union — kept in lockstep with `lib/flows/types.ts` by hand, no shared
  import), `flow-editor-state.tsx` (`defaultConfigFor`),
  `forms/node-config-form.tsx`, **both** `flow-builder.tsx` **and**
  `flow-canvas.tsx` (two separate duplicated "addable node types"
  arrays — a node only added to one is pickable in just one of the two
  editor views), `lib/flows/edges.ts` (canvas edge derivation +
  drag-to-connect + delete-cleanup — four switch statements, three of
  which are TS-exhaustiveness-checked and will fail `tsc` if a case is
  missing), `lib/flows/templates.ts` (its own separate
  `FlowTemplateNodeType` union, for seed templates), and all three
  locale files (`src/i18n/messages.test.ts` enforces parity).
- **Seed template**: `book_appointment` in `src/lib/flows/templates.ts`
  — clone-and-go once Settings → Salon booking is configured. Templates
  in this repo are a single hardcoded English-content module (no
  per-locale template variants), matching the existing
  `welcome_menu`/`faq_bot`/`lead_capture` convention.

## WhatsApp contact identity (phone vs. BSUID)

Meta's "WhatsApp usernames" rollout (live since 2026-03-31, mandatory by
June 2026) lets a customer hide their phone number from a business.
**Confirmed against a real payload from an affected account** (2026-08-22
— prior guesses based on third-party blog posts were wrong on one key
point, see the change log below): when a customer has hidden their
number, `messages[].from` is **absent entirely** (not present-but-odd)
and the identifier instead lives in `messages[].from_user_id` —
mirrored on `contacts[].user_id` — format `CC.digits`, e.g.
`PE.1128521366369305` ("PE" = the country code, matching the business
number's own country in the observed case; the digit run after the dot
may not always be all-digits, don't assume it). `contacts[].wa_id` is
also absent for such a contact. `contacts[].profile` additionally
carries an optional `username` (plain ASCII, the customer's real
@handle, e.g. `"thali.vd_"`) alongside `name`, which for a
username-having customer can be a **decorative Unicode string**
(stylized mathematical-alphanumeric symbols) that renders as garbled
boxes in the inbox — prefer `username` over `name` when present.

`processMessage` (`src/app/api/whatsapp/webhook/route.ts`) resolves the
sender id with `message.from ?? message.from_user_id ?? contact.user_id
?? ''`, and the display name with `contact.profile.username ||
contact.profile.name`. `findOrCreateContact` detects a non-phone id by
checking the **raw** string against `/^\+?\d{5,15}$/` — deliberately not
by checking whether `normalizePhone(id)` came out empty, since a BSUID
can contain enough stray digits to normalize into a plausible-looking
(and possibly colliding) fake phone number. When it doesn't look like a
phone, the raw id is used as an exact-match dedup/storage key instead of
going through `findExistingContact`'s digit-suffix `phonesMatch` logic.

This is still a **stopgap** for the duplicate-contact symptom only —
outbound sends to such a contact still fail (`sanitizePhoneForMeta`/
`isValidE164` in `src/lib/flows/meta-send.ts` /
`src/lib/automations/meta-send.ts` reject a non-phone stored value like
`"PE.1128521366369305"` — the error just changes from "contact not
found" to "contact phone invalid" once dedup is fixed). The real fix
needs a dedicated identity column (`contacts.phone` is `NOT NULL` and
drives a generated `phone_normalized` column + a per-account unique
index, migration 022 — a BSUID doesn't fit that model), an updated
migration, and BSUID-aware outbound sending across every `meta-send.ts`
call site plus broadcasts. Not done yet.

# Change log (Claude Code sessions)

## 2026-08-02 — Add OpenRouter as a third AI provider

The Agents module only offered OpenAI and Anthropic as BYO-key
providers. Added OpenRouter (OpenAI-compatible `chat/completions` API,
routed vendor-prefixed model IDs like `openai/gpt-5.4-mini`).

Touched:

- [src/lib/ai/types.ts](src/lib/ai/types.ts) — `AiProvider` gains `'openrouter'`
- [src/lib/ai/config.ts](src/lib/ai/config.ts) — `AiConfigRow.provider` union widened to match
- [src/lib/ai/defaults.ts](src/lib/ai/defaults.ts) — default model `openrouter: 'openai/gpt-5.4-mini'`
- [src/lib/ai/providers/openrouter.ts](src/lib/ai/providers/openrouter.ts) — new adapter, cloned from `providers/openai.ts` against `https://openrouter.ai/api/v1/chat/completions`
- [src/lib/ai/generate.ts](src/lib/ai/generate.ts) — dispatches to the new adapter
- [src/app/api/ai/config/route.ts](src/app/api/ai/config/route.ts), [src/app/api/ai/test/route.ts](src/app/api/ai/test/route.ts) — provider validation allows `'openrouter'`
- [src/components/settings/ai-config.tsx](src/components/settings/ai-config.tsx) — provider label ("OpenRouter"), key placeholder (`sk-or-v1-...`), `<SelectItem>`, default-model swap logic
- [supabase/migrations/037_add_openrouter_provider.sql](supabase/migrations/037_add_openrouter_provider.sql) — **new migration, must be applied**: widens the `ai_configs` and `ai_usage_log` CHECK constraints to allow `'openrouter'`
- [messages/en.json](messages/en.json), [messages/ko.json](messages/ko.json) — settings description mentions OpenRouter

Embeddings (semantic KB search) stayed OpenAI-only — neither Anthropic
nor OpenRouter expose an embeddings endpoint, so `embeddings.ts` is
unchanged.

Verified: `npm run typecheck` and `npx eslint` clean on every touched
file (pre-existing `mcp-server/` type errors are unrelated — that
package's own deps aren't installed at the repo root); `next build`
compiles the app successfully.

> **Migration required for self-hosters:** apply
> `supabase/migrations/037_add_openrouter_provider.sql` against your
> Supabase project before selecting OpenRouter in Settings → Agents,
> otherwise saving/logging usage will fail the old CHECK constraint.

## 2026-08-02 — Fix editing/moving/deleting steps nested inside a condition branch

Reported symptom: in the Automations builder, a "Send Message" action
placed under a Condition's YES/NO branch (e.g. the built-in
`out_of_office` template, `/automations/new?template=out_of_office`)
wouldn't let the "Message text" textarea be edited — typing had no
visible effect. The Delete button on that same node also rendered the
raw, untranslated string `"Automations.builder.delete"` instead of
"Delete".

These were two independent, unrelated bugs that happened to show up in
the same screenshot because the `out_of_office` template nests its only
action inside a branch:

1. **Path-construction bug (the actual "can't edit" cause), longstanding
   since the builder's original commit.** In `StepRenderer`
   ([src/components/automations/automation-builder.tsx](src/components/automations/automation-builder.tsx))
   the `StepPath` for a node was built by *appending* a new path segment
   to `parentPath` unconditionally. For a root-level node `parentPath`
   is `[]`, so that's correct. But for a node inside a branch,
   `ConditionBranches` had already appended a placeholder branch-marker
   segment to the `parentPath` it hands down (`index: 0`, meant to be
   *replaced* per the comment at its call site — never was). Appending
   on top of that gave every branch-nested node a path one segment too
   long, so `mapAtPath`/`removeAt`/`moveAt` recursed one level too deep
   — into `nodeBeingEdited.branches`, which is `undefined` for anything
   that isn't itself a `condition` — and silently returned the tree
   unchanged. Root cause of "typing does nothing", and identically broke
   the Move Up/Down and Delete buttons for any step nested at least one
   level inside a Yes/No branch (not just `send_message`, not just
   textareas — creating new steps via "Add step" was unaffected, since
   that path only relies on `parentScope`, not the buggy `path`).

   Fix: when `parentScope.kind === "branch"`, replace the trailing
   placeholder segment of `parentPath` with the child's real index
   (`[...parentPath.slice(0, -1), {...}]`) instead of appending a new
   one — matching the behavior the original comment already described.

2. **Missing i18n key.** `t("delete", { defaultValue: "Delete" })` at
   the Delete button — `next-intl` v4 has no `defaultValue` option (see
   the Automations builder note above), and `Automations.builder.delete`
   was simply never added to `messages/en.json`/`messages/ko.json`
   (a different `Automations.list.delete` exists, wrong namespace).
   Unrelated to nesting — reproducible on any expanded step's Delete
   button, top-level or branch-nested; the screenshot just happened to
   show a branch-nested one.

Touched:

- [src/components/automations/automation-builder.tsx](src/components/automations/automation-builder.tsx) — `StepRenderer`'s `path` construction (replace-last-segment instead of always-append)
- [messages/en.json](messages/en.json), [messages/ko.json](messages/ko.json) — added `Automations.builder.delete`

No DB migration needed. Verified: `npx tsc --noEmit` and `npx eslint`
clean on the touched file; both locale files still parse as valid JSON.
Not verified in-browser — the local dev server requires Supabase login
credentials this session didn't have access to (entering passwords is
outside what this assistant will do); functional confirmation of the
YES-branch textarea now accepting edits is still recommended before you
consider this closed.

## 2026-08-02 — Add Spanish (`es`) locale

Full Spanish translation, third locale alongside `en` (source of truth)
and `ko`. Neutral/international Spanish register suitable for both Spain
and Latin America, matching the casual-professional tone of the English
UI copy.

Touched:

- [messages/es.json](messages/es.json) — new, full translation of every
  `en.json` key (1700 lines, same structure/nesting/array lengths).
  Brand/product names (wacrm, WhatsApp®, Meta, OpenAI, Anthropic,
  OpenRouter, Supabase) and code-like values (cron expressions, API key
  format hints, JSON snippet placeholders) left untranslated by design.
  The WhatsApp setup wizard's step-by-step instructions
  (`Settings.whatsapp.step*`) deliberately keep Meta's own English
  dashboard button/label names (e.g. "My Apps", "API Setup", "Phone
  Number ID") in place — those are literal labels the user will see on
  Meta's (English-only) screen, so translating them would make the
  instructions stop matching what's on screen.
- [src/i18n/messages.test.ts](src/i18n/messages.test.ts) —
  `TRANSLATED_LOCALES` gains `'es'`, so the existing key-parity test now
  guards this file the same way it already guarded `ko.json`.
- [.env.local.example](.env.local.example) — locale comment now lists
  `es` as an option.

No code change needed to actually serve it — `src/i18n/request.ts`
already dynamically imports `messages/${locale}.json` by
`NEXT_PUBLIC_APP_LOCALE`; self-hosters opt in by setting
`NEXT_PUBLIC_APP_LOCALE=es`. See the new **i18n / locales** section
above for how the single build-time locale + parity-test mechanism
works.

Verified: `npx vitest run src/i18n/messages.test.ts` passes (4/4 —
no-missing-keys and no-orphaned-keys, for both `ko` and `es`); a
separate placeholder/ICU-variable audit across all 1430 leaf keys found
zero mismatches between `en.json` and `es.json` interpolation names
(`{count}`, `{name}`, etc.) and `plural` variable selectors. Not
verified in-browser (same login-credential limitation as above) — spot
render of the Spanish UI with `NEXT_PUBLIC_APP_LOCALE=es` is recommended
before considering this closed.

## 2026-08-09 — Salon booking: automatic WhatsApp appointment requests via an external API

User asked whether the WhatsApp bot could make automatic bookings,
initially framed around Google Calendar. Plan changed mid-design: the
user has their own salon-management system (separate Laravel + Sanctum
backend/frontend, not part of this repo) that already owns appointment
data — wacrm should register bookings *into* that system instead of
building/syncing a calendar. See the new **Salon booking (external API,
via Flows)** architecture section above for the full design; this entry
covers what shipped.

Explored and ruled out first: Automations (no multi-turn conversation
state — can't do "what day? → wait → what time?"), a native
appointments/calendar entity (the salon system is already the source of
truth; duplicating it would be the exact opposite of "sin hacer
demasiados cambios"), and Google Calendar OAuth2 (the user's system uses
a static Sanctum Bearer token instead — no OAuth, no refresh-token
machinery needed, simpler than the Calendar plan it replaced).

Touched:

- [supabase/migrations/038_salon_booking.sql](supabase/migrations/038_salon_booking.sql)
  — **new migration, must be applied**: `salon_booking_configs` table
  (admin-only RLS) + widens `flow_nodes_node_type_check` to allow
  `'create_salon_appointment'`.
- [src/lib/salon-booking/config.ts](src/lib/salon-booking/config.ts),
  [client.ts](src/lib/salon-booking/client.ts) — new: config loader
  (decrypts the stored token) + plain-fetch REST client
  (`createAppointment`, `testConnection`), mirroring
  `src/lib/ai/providers/*`'s no-SDK style.
- [src/lib/flows/types.ts](src/lib/flows/types.ts),
  [engine.ts](src/lib/flows/engine.ts),
  [validate.ts](src/lib/flows/validate.ts),
  [templates.ts](src/lib/flows/templates.ts),
  [edges.ts](src/lib/flows/edges.ts) — new `create_salon_appointment`
  node type: config shape, execution (strict `date-fns` date/time
  parsing, builds `notas_cliente` automatically, calls the salon API),
  activation validation, the `book_appointment` seed template, and
  canvas edge derivation/drag-connect/delete-cleanup.
- [src/components/flows/shared.tsx](src/components/flows/shared.tsx),
  [flow-editor-state.tsx](src/components/flows/flow-editor-state.tsx),
  [forms/node-config-form.tsx](src/components/flows/forms/node-config-form.tsx),
  [flow-builder.tsx](src/components/flows/flow-builder.tsx),
  [flow-canvas.tsx](src/components/flows/flow-canvas.tsx),
  [src/app/(dashboard)/flows/page.tsx](<src/app/(dashboard)/flows/page.tsx>)
  — node registered across every UI surface that enumerates node types
  (two separate "addable types" lists, one per editor view — both
  needed updating) + the template-gallery icon map (own separate
  `"MessageSquare"|"HelpCircle"|"UserPlus"` union, now `+"CalendarCheck"`).
- [src/app/api/salon-booking/config/route.ts](src/app/api/salon-booking/config/route.ts),
  [test/route.ts](src/app/api/salon-booking/test/route.ts),
  [src/components/settings/salon-booking-config.tsx](src/components/settings/salon-booking-config.tsx)
  — new Settings → "Salon booking" panel, cloning the `ai-config.tsx` /
  `api/ai/config`+`api/ai/test` shape (masked token, Test-connection
  button, validate-before-save).
- [src/components/settings/settings-sections.ts](src/components/settings/settings-sections.ts),
  [src/app/(dashboard)/settings/page.tsx](<src/app/(dashboard)/settings/page.tsx>)
  — registered the new `'salon-booking'` section.
- `messages/en.json`, `messages/es.json`, `messages/ko.json` — new
  keys for the node label/form and the settings panel.
- [src/lib/flows/engine.test.ts](src/lib/flows/engine.test.ts),
  [validate.test.ts](src/lib/flows/validate.test.ts),
  [src/components/flows/flow-editor-state.test.ts](src/components/flows/flow-editor-state.test.ts)
  — new cases, including unit tests for the newly-exported pure
  `parseSalonDateTime` helper (this repo's existing pattern for testing
  engine logic without a Supabase/fetch mock).

While fixing an unrelated i18n test failure surfaced by this work's
`npx vitest run src/i18n/messages.test.ts` run, found and fixed a
**pre-existing gap in `es.json`**: 18 keys (`Automations.builder.config.
matchWord`/`matchWordHint`, all of `Inbox.mediaViewer.*`, 5 of
`Inbox.bubble.*`) that the `es.json` creation session (see the entry
above) had missed — unrelated to salon booking, just something the
parity-test gate happened to catch while this session was already
running it.

Verified: `npm run typecheck`, `npx eslint` (0 errors, only pre-existing
warnings), `npx vitest run` for the **full** suite — 727/729 pass; the 2
failures (`src/lib/dashboard/date-utils.test.ts`, `mondayIndex`) are
pre-existing, unrelated (confirmed via `git status`/`git diff` — that
file was never touched this session) and look like environment
timezone-dependent flakiness in a `new Date("2026-05-18")` parse, not a
regression from this change.

> **Migration required for self-hosters:** apply
> `supabase/migrations/038_salon_booking.sql`, then generate a Sanctum
> Personal Access Token on the salon backend and enter it (+ the base
> URL and the placeholder client/status/service ids) in Settings →
> Salon booking before cloning/activating the `book_appointment`
> template. Not verified end-to-end against a real salon backend or a
> real WhatsApp number this session — the user still needs to supply
> the actual token, base URL, and placeholder ids, and confirm a live
> booking round-trip.

## 2026-08-22 — Auto-reply handoff now sends the model's farewell message

Reported: MlennyBot (this fork's AI assistant persona) is designed to
say something graceful before handing off to a human ("Lamentamos lo
ocurrido... una integrante de nuestro equipo continuará..."), but the
customer was getting silence instead. Traced to
`dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts`): the
`if (handoff || !text) { ...; return }` branch discarded `text`
unconditionally before returning — whatever the model wrote alongside
the `[[HANDOFF]]` sentinel never reached `engineSendText`. Compounding
it, the auto-reply scaffold (`buildSystemPrompt`, `src/lib/ai/
defaults.ts`) told the model to reply with the sentinel "and nothing
else," so even fixing the send path alone wouldn't have produced a
paired message in practice.

Touched:

- [src/lib/ai/auto-reply.ts](src/lib/ai/auto-reply.ts) — when `text` is
  non-empty on the handoff branch, sends it before disabling auto-reply,
  gated by the same `claim_ai_reply_slot` atomic-cap RPC a normal reply
  uses, wrapped in its own try/catch so a send failure can't skip the
  handoff bookkeeping (confirmed via a new test: farewell-send-throws
  still marks `ai_autoreply_disabled`).
- [src/lib/ai/defaults.ts](src/lib/ai/defaults.ts) — scaffold instruction
  now allows (doesn't require) a short customer-facing sentence before
  the sentinel.
- [src/lib/ai/auto-reply.test.ts](src/lib/ai/auto-reply.test.ts) — 3 new
  cases: paired message sent + slot claimed, message dropped silently
  when the slot-claim race is lost, handoff bookkeeping survives a send
  throw.

Also delivered as content (not code, per the user's own request):
an adapted Spanish system-prompt for `ai_configs.system_prompt` — trimmed
of instructions the scaffold already covers (language matching, output
format, prompt-injection defense, the `[[HANDOFF]]` protocol itself) so
it doesn't duplicate or fight the built-in scaffold — plus guidance on
structuring the Knowledge Base as one document per service/category
rather than one large catalog, since retrieval pulls the top-5 chunks
and unrelated services in the same chunk compete for that budget.

Verified: `npx tsc --noEmit`, `npx eslint` (0 errors), full `npx vitest
run` — only the same pre-existing, unrelated `date-utils.test.ts`
failures. Decision explicitly deferred, per the user's own MlennyBot
prompt (which never lets the bot confirm a booking itself): no AI
tool-calling / function-calling capability was added. The AI still only
drafts text; the `create_salon_appointment` Flow node (see above) or a
human remains the only path that actually books.

## 2026-08-22 — WhatsApp contact-duplication stopgap (BSUID / usernames)

Reported: every inbound message from certain customers was creating a
**new** contact instead of reusing the existing one — inbox filled with
one-message "contacts" all showing the same (garbled) name. Root-caused
via `git log`-free code inspection plus a live Meta Cloud API doc check
(see **WhatsApp contact identity** section above for the durable
explanation): Meta's "WhatsApp usernames" feature can put a
non-phone Business-Scoped User ID in `messages[].from`; this repo's
`normalizePhone()` reduces that to `''`, `findExistingContact` bails
immediately on an empty normalized phone, and the per-account unique
index (migration 022) explicitly excludes empty `phone_normalized` — so
nothing anywhere stops a fresh insert every time. Confirmed by a second
symptom in the same investigation: `[ai auto-reply] dispatch failed:
Error: contact not found for this account`, traced to `engineSendText`
(`src/lib/flows/meta-send.ts:76-78`) treating a found-but-phoneless
contact row as "not found."

Shipped a **stopgap only** — stops the duplicate-contact pileup, does
**not** fix outbound sending to these contacts (still fails, now with a
clearer "contact phone invalid" error instead of "not found"). The full
fix (dedicated BSUID identity column + migration + updated outbound
send across every `meta-send.ts` call site) needs a real webhook payload
from an affected account, not yet obtained — user was asked twice; the
server-log excerpts shared didn't include the raw webhook JSON, only
downstream error traces (which were enough to confirm the root cause,
just not the exact BSUID field shape to build the full fix against).

Touched:

- [src/app/api/whatsapp/webhook/route.ts](src/app/api/whatsapp/webhook/route.ts)
  — `findOrCreateContact` gained a 5th arg (`rawSenderId`, the untouched
  `message.from`). Detects "this isn't a phone number" by testing the
  **raw** string against `/^\+?\d{5,15}$/` — NOT by checking whether
  `normalizePhone()` came out empty, because a first attempt at this fix
  used that check and its own test caught the bug: a BSUID can contain
  enough stray digits to normalize into a plausible-looking, wrong
  "phone." When non-phone, dedupes/creates by an exact string match on
  the raw id (bypassing `findExistingContact`'s digit-suffix
  `phonesMatch`, which could false-positive-collide two different BSUID
  customers).
- [src/app/api/whatsapp/webhook/route.test.ts](src/app/api/whatsapp/webhook/route.test.ts)
  — new `contacts` table case in the Supabase mock (only exercised by
  the fallback path) + 2 new tests proving one contact gets created and
  reused across two messages from the same non-phone `from`.

Verified: `npx tsc --noEmit`, `npx eslint` (0 errors, 1 pre-existing
unrelated warning), full `npx vitest run` — only the same pre-existing
`date-utils.test.ts` failures remain.

> **Follow-up needed, not done this session:** get a real raw webhook
> payload from an affected message (Meta App Dashboard → Webhooks →
> recent deliveries, or a temporary raw-body `console.log` in the POST
> handler) to (a) confirm the exact BSUID field/shape this account
> actually receives, and (b) design the real fix — a dedicated identity
> column, an updated migration, and BSUID-aware outbound sending in
> `src/lib/flows/meta-send.ts`, `src/lib/automations/meta-send.ts`, and
> broadcast sending. Until then, replying to a hidden-number customer
> from wacrm does not work.

## 2026-08-22 — WhatsApp contact-duplication stopgap: corrected against a real payload

The prior stopgap (previous entry, same day) shipped based on
third-party documentation of Meta's BSUID format and never actually
engaged in production — a temporary debug log
(`console.log('[webhook DEBUG] raw inbound payload:', rawBody)`,
gated on `rawBody.includes('"messages"')`, added to the `POST` handler)
captured a real payload from the affected account, which showed the
guess was wrong on the load-bearing detail: `messages[].from` isn't
present-but-garbled for a hidden-number sender, it's **absent
entirely**. The real identifier lives in `messages[].from_user_id`
(mirrored on `contacts[].user_id`), which the prior fix never read —
so `rawSenderId` was `undefined`, `!!rawSenderId` was `false`,
`usingFallbackId` never activated, and the code fell straight back to
the original bug path (empty `phone`, new contact every message).
Confirmed still happening via a second real-log excerpt from the same
account (still creating new "contact not found" auto-reply failures)
before this fix.

Also discovered in the same payload: `contacts[].profile` can carry an
optional `username` (plain ASCII — the real @handle) alongside `name`,
which for a username-having customer is a decorative Unicode string
(stylized mathematical-alphanumeric glyphs) that renders as garbled
boxes in the inbox — exactly what the user's original screenshot showed
("□□□□□□□3"). Not previously known or handled.

Touched:

- [src/app/api/whatsapp/webhook/route.ts](src/app/api/whatsapp/webhook/route.ts)
  — `WhatsAppMessage.from` → optional, added `from_user_id?: string`;
  `WhatsAppWebhookEntry`'s `contacts[].wa_id` → optional, added
  `user_id?: string` and `profile.username?: string`. `processMessage`
  now resolves the sender id via `message.from ?? message.from_user_id
  ?? contact.user_id ?? ''` and the display name via
  `contact.profile.username || contact.profile.name`, instead of
  reading `message.from`/`contact.profile.name` alone. Removed the
  temporary debug log now that it's served its purpose.
  `findOrCreateContact`'s own `looksLikePhone`/`usingFallbackId` logic
  needed no change — it was correct in principle, it just never
  received the right input.
- [src/app/api/whatsapp/webhook/route.test.ts](src/app/api/whatsapp/webhook/route.test.ts)
  — `inboundRequest`/`runWebhook` gained an optional `contacts` param
  (default unchanged, so every pre-existing test is unaffected); the
  BSUID test fixture corrected from a fabricated
  `from: 'BR.1A2B3C4D5E6F7G8H9I0J'` shape to the confirmed real one
  (`from_user_id`, no `from` key, `contacts[].user_id` +
  `profile.username`); added a third test asserting `username` is
  preferred over the decorative `name` for the stored contact.

Verified: `npx tsc --noEmit`, `npx eslint` (0 errors, same
pre-existing `downloadMedia` unused-import warning), `npx vitest run`
on the file (18/18) and the full suite (only the same pre-existing,
unrelated `date-utils.test.ts` failures). Not verified against a
second live inbound message from the same customer post-deploy — the
user should confirm the next message from `user_id
"PE.1128521366369305"` (or any other hidden-number customer) lands on
the same existing contact rather than creating a new one.

**Still not fixed, same as the prior entry:** outbound sending to
these contacts. `contacts.phone` now holds the non-empty raw id
(`"PE.1128521366369305"`), so `meta-send.ts`'s `!contact?.phone` guard
no longer trips — but `sanitizePhoneForMeta`/`isValidE164` immediately
after it will reject that value as an invalid phone, so the error just
changes shape (`"contact phone invalid: ..."` instead of `"contact not
found"`). AI auto-reply, Flow sends, and automation sends to a
hidden-number customer still don't deliver. The full fix (dedicated
identity column, migration, BSUID-aware outbound sending across every
`meta-send.ts` call site plus broadcasts) remains a separate,
explicitly-deferred follow-up.
