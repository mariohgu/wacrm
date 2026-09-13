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
  `ai_configs` (AES-256-GCM at rest via `src/lib/whatsapp/encryption.ts`).
  Also owns `resolveAuxiliaryEndpoint` — see "Auxiliary OpenAI-only
  capabilities" below for what that's for.
- `generate.ts` — `generateReply` dispatches to the right provider
  adapter by `config.provider`, then strips the `[[HANDOFF]]` sentinel
- `context.ts` — `buildConversationContext` (last N text messages →
  `ChatMessage[]`) and `buildCustomerContext` (CRM lookup: name, phone,
  whether the customer has written before). The latter deliberately
  never surfaces `contacts.phone` when it's a WhatsApp-usernames BSUID
  placeholder rather than a real number (`looksLikePhoneNumber` gate) —
  see the "WhatsApp contact identity" section. Both feed
  `defaults.ts`'s `buildSystemPrompt`, which — when given a
  `customer` — adds a "Customer record" paragraph telling the model
  not to ask again for a name/number already on file, and whether this
  is a returning customer ("more than one customer message in this
  conversation," since this CRM reuses one conversation per contact
  rather than starting a fresh thread per session). Wired into both
  `auto-reply.ts` (the bot) and `api/ai/draft/route.ts` (the inbox
  "draft" button) — NOT into `api/ai/playground/route.ts`, which is a
  stateless test chat with no real conversation/contact to look up.
- `providers/{openai,anthropic,openrouter}.ts` — one adapter per
  provider; `providers/shared.ts` has the cross-provider helpers
  (usage normalization, HTTP/network error mapping, turn merging)
- `embeddings.ts` — optional semantic KB search (`embedTexts`, fixed at
  `text-embedding-3-small`/1536-dim to match the `vector(1536)` column
  in migration 030 — see the auxiliary-endpoint section below for how
  it's reached)
- `transcription.ts` — `transcribeAudio`, voice-note → text (see below)
- UI: `src/components/settings/ai-config.tsx` (provider/model/key form),
  `src/components/agents/ai-playground.tsx`, `ai-usage.tsx`
- API: `src/app/api/ai/config/route.ts` (save/load, validates key with
  the provider before persisting), `src/app/api/ai/test/route.ts`
  ("Test key" button), `src/app/api/ai/draft/route.ts` (inbox draft)
- DB: `ai_configs` (per-account config + encrypted key,
  `supabase/migrations/029_ai_reply.sql`), `ai_usage_log` (token spend,
  `033_ai_reply_polish.sql`) — both CHECK-constrain `provider`, so a new
  provider needs a migration widening both constraints, not just app code

### Auxiliary OpenAI-only capabilities (embeddings, transcription)

Two features need an OpenAI-compatible endpoint that isn't the chat
`generateReply` path: embedding the knowledge base (`embeddings.ts`)
and transcribing inbound voice notes (`transcription.ts`, see the
"Voice-note transcription" section below). Neither Anthropic nor
plain-OpenAI-SDK usage covers this for an account on another
provider — but **OpenRouter now offers both an `/embeddings` and an
`/audio/transcriptions` endpoint**, OpenAI-wire-compatible, using the
same key already configured for chat (vendor-prefixed model ids like
`openai/text-embedding-3-small`, `openai/gpt-4o-mini-transcribe`).

`config.ts`'s `resolveAuxiliaryEndpoint` is the single place that
decides where to send these requests, given the account's already-
configured `provider`/`api_key`:

1. **A fallback key wins first** (`embeddings_api_key` /
   `transcription_api_key`) — always routes to `api.openai.com`
   directly. This is the only path for an Anthropic account (no
   native endpoint at all), and always takes precedence for any
   provider so an account that configured one before this routing
   existed sees no behavior change.
2. **`provider: 'openai'`** — routes to `api.openai.com` using the
   main chat key, no extra configuration needed.
3. **`provider: 'openrouter'`** — routes to `openrouter.ai/api/v1`
   using the main chat key, with a vendor-prefixed default model.
4. Anthropic with no fallback key → `null` (no capability).

Two async wrappers query `ai_configs` directly:
`loadEmbeddingsEndpoint` (replaces the old `loadEmbeddingsKey` —
independent of `is_active`, used by the 3 knowledge ingest/reindex
routes) and `loadTranscriptionEndpoint` (used only by the inbound
webhook). A third, synchronous `deriveEmbeddingsEndpoint(config)`
resolves from an already-loaded `AiConfig` — used by
draft/auto-reply/playground, which have one in hand already, to avoid
a second DB round trip on the reply hot path.

Embeddings deliberately has **no model override** — the KB's vectors
are anchored to a fixed 1536-dim column (migration 030), so letting an
account pick an arbitrary model risks a dimension mismatch;
`embedTexts` now also throws if a returned vector isn't exactly 1536
dims, catching a bad model id before it reaches the DB. Transcription
**does** allow a model override (`ai_configs.transcription_model`,
migration 040) — plain text output has no such constraint.

## Voice-note transcription

Inbound WhatsApp voice notes are transcribed to text at webhook-
ingestion time and written into the existing `messages.content_text`
column (previously always `null` for audio — WhatsApp doesn't carry a
caption field on voice notes). That single write is what makes this
"free" everywhere else: the Inbox bubble, `buildConversationContext`
(widened from `.eq('content_type','text')` to
`.in('content_type', ['text','audio'])`), and any automation/Flow logic
already reading `content_text` all pick it up with no separate wiring.

- `src/app/api/whatsapp/webhook/route.ts`'s `parseMessageContent`
  (audio case) calls `loadTranscriptionEndpoint` — `null` (no key
  configured on any path) skips transcription entirely, same
  `content_text: null` as before this existed. When resolved, it
  downloads the audio via `getMediaUrl`/`downloadMedia`
  (`src/lib/whatsapp/meta-api.ts` — the same primitives
  `mirror-inbound-media.ts` already uses) rather than reading
  `messages.media_url`, since that can be a relative,
  non-server-fetchable proxy path when the account has media
  mirroring disabled.
- `transcription.ts`'s `transcribeAudio` never throws — network
  errors, a non-2xx response, a missing `text` field, or a buffer over
  OpenAI's 25MB cap all log and return `null`, so a transcription
  failure can never break inbound message ingestion. Confirmed against
  OpenAI's/OpenRouter's own docs that OGG (WhatsApp's voice-note
  format) is accepted directly — no server-side audio
  conversion/`ffmpeg` needed, consistent with this project's own PR
  history removing server-side ffmpeg for voice notes.
- Inbox display: `message-bubble.tsx`'s `case "audio":` shows a small
  "Transcript" chip (mirroring the `case "template":` badge pattern) +
  the text in italics when `content_text` is present — visually
  distinct from a real caption, so it doesn't read as customer-typed.
- No live "Test key" validation for the transcription fallback field
  (unlike embeddings' cheap synthetic-embed ping) — there's no cheap
  way to validate without sending a real audio sample, and
  synthesizing one server-side would reintroduce the audio-processing
  complexity this project deliberately avoided. An invalid key/model
  just means transcription silently doesn't happen.

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

That username-preferring `name` is only ever written to an **existing**
contact's `name` column when the column is currently empty
(`if (name && !existingContact.name)`, both in the username-match
branch and the phone/BSUID-fallback branch) — never as an
unconditional overwrite. A contact's name is set once, either at
creation or the first time staff/automation fills it in; every later
inbound message only refreshes `wa_user_id`/`wa_username`/`phone`
(routing/identity data), never `name` again. This matters because
`name` naturally prefers the WhatsApp @handle over `profile.name` (see
above) — without the "only if empty" guard, a customer's real name
entered by staff (e.g. "Mario") would get silently renamed back to
their raw username (e.g. "mariof737") on every subsequent message, since
the two will almost always differ (bug reported and fixed 2026-08-23,
see change log).

**Update, 2026-08-22 (same day, later): the BSUID token itself is not a
stable identity.** Deduping purely on `wa_user_id`/`from_user_id` (the
paragraphs above) breaks once Meta rotates that token for a returning
customer — confirmed in production: a contact whose real phone had
already been saved manually still got a second "new" row under a fresh
BSUID. The one signal that *is* durable is `contacts[].profile.username`
(the public @handle, e.g. `"thali.vd_"` — plain ASCII, unlike the
possibly-decorative `name`). Migration
[040_wa_username_identity.sql](supabase/migrations/040_wa_username_identity.sql)
adds it as a proper identity column, so contact identity for a
WhatsApp-usernames customer is now a **three-signal model**:

1. **`phone`** — the real, stable identifier when Meta discloses it
   (unchanged, still `NOT NULL`, still drives `phone_normalized` +
   migration 022's per-account unique index).
2. **`wa_username`** (+ generated `wa_username_normalized`, lowercased,
   unique per account when non-null) — the durable identity for a
   customer who has hidden her number. `processMessage` checks this
   **first**, before the phone/BSUID fallback: a match here reuses the
   contact regardless of what token or phone-like value shows up this
   time. Editable by staff (`contact-form.tsx`'s create/edit dialog,
   `contact-detail-view.tsx`'s Details tab) to manually link a known
   username onto an existing phone-having contact.
3. **`wa_user_id`** — the current/last-known BSUID routing token.
   Refreshed automatically on every inbound message; deliberately has
   no uniqueness constraint (plain index only) since it can rotate and
   two rows could transiently share a stale value. Read-only in the
   UI. Now also used for outbound sends — see below.

Capture is **opportunistic**: even a message that arrives with a real,
visible phone number also gets its `wa_username`/`wa_user_id` stored (if
present and not already known) onto that same contact, so if that same
customer later hides her number, the system already knows who she is —
no manual linking needed for anyone captured this way. Manual linking
(step 2 above) exists for the case where the BSUID-only contact and the
phone-having contact were already created as two separate rows *before*
this existed.

**Cleaning up a pre-existing duplicate pair**: `merge_contacts(survivor,
loser)` (same migration) re-points a loser contact's conversations,
notes, deals, tags, custom values, and non-active flow runs onto a
survivor and deletes the loser — same table breakdown as migration 022's
`merge_duplicate_contacts()`, but for an explicit id pair chosen by
staff rather than an automatic phone-group scan. `SECURITY DEFINER`,
`EXECUTE` granted to `service_role` only (never `authenticated` — it
bypasses RLS and deletes rows, so it must never be reachable by direct
RPC from the browser client). The only caller is
`POST /api/contacts/[id]/merge`
([route.ts](<src/app/api/contacts/[id]/merge/route.ts>)), which requires
the `admin` role and verifies both contact ids belong to the caller's
own account before invoking the RPC through
[src/lib/contacts/admin-client.ts](src/lib/contacts/admin-client.ts)'s
service-role client — the API route is the only place that
authorization happens; the SQL function trusts its caller completely.
Reachable from `contact-detail-view.tsx`'s "Merge with another contact"
button (search-and-confirm dialog).

**Outbound sending to a username-only/BSUID-only contact now works**
(see the 2026-08-22 "Outbound sends via `recipient`" entry below) for
Inbox replies, the public messages API, Flows, Automations, and
reactions — every one-to-one/conversational send path builds a Meta
`recipient` field (the BSUID) instead of `to` (phone-only) when
`contacts.phone` isn't a real phone number. **Broadcasts (campaign
sends) are the one remaining gap** — `src/lib/whatsapp/broadcast-core.ts`
and `src/app/api/whatsapp/broadcast/route.ts` never query `contacts` at
send time (they're phone-string-driven end to end), so there's no
`wa_user_id` to route through without new schema/UI plumbing. Not yet
started.


## PWA / installed-app baseline (`src/app/manifest.ts`, safe areas)

The app is installable as a Progressive Web App ("Add to Home Screen"
on iOS Safari, the install prompt on Android Chrome) and, once
installed, opens standalone (no browser chrome). What exists today is
the **installability + layout** layer only — there is deliberately
**no service worker and no push** yet (see the phased plan in the
2026-09-12 change-log entry; those are later phases).

- [src/app/manifest.ts](src/app/manifest.ts) — Next's file convention,
  served at `/manifest.webmanifest` with the `<link rel="manifest">`
  auto-injected. `start_url: "/inbox"`, `display: "standalone"`.
  Colors come from `THEME_COLOR_BY_MODE` (below), not literals.
- `public/icons/` — `icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png` (full-bleed, glyph in the 80% safe zone for
  Android adaptive masks), `apple-touch-icon.png` (180px, square,
  opaque — iOS applies its own mask). All rendered from the same brand
  mark as `src/app/icon.tsx` via a one-off `sharp` script (not
  checked in); regenerate the same way if the mark changes.
- [src/lib/themes.ts](src/lib/themes.ts) — `THEME_COLOR_BY_MODE`
  (`dark: "#05070b"`, `light: "#fbfcfd"`): sRGB hex of the two
  `--background` oklch tokens in `globals.css`. **Must be kept in sync
  by hand** if those tokens change — used by the manifest, the static
  `<meta name="theme-color">` tags, and the runtime sync in
  `use-theme.tsx`.
- [src/app/layout.tsx](src/app/layout.tsx) — `viewport` now declares
  `viewportFit: "cover"` (page extends under notch/home indicator when
  installed), `interactiveWidget: "resizes-content"` (on-screen
  keyboard shrinks the layout viewport so the inbox composer moves up
  instead of being covered), and per-`prefers-color-scheme`
  `themeColor` entries. `metadata.appleWebApp` (`capable`,
  `statusBarStyle: "black-translucent"`) and `icons.apple` cover iOS,
  which ignores the manifest icons.
- [src/hooks/use-theme.tsx](src/hooks/use-theme.tsx) — an effect
  rewrites every `meta[name="theme-color"]` to `THEME_COLOR_BY_MODE[mode]`
  whenever the in-app mode changes. Needed because the app's
  light/dark choice is its own axis (`data-mode`), not
  `prefers-color-scheme`, so the static tags alone would give a
  light-mode user on a dark-preference phone a dark status bar.
- **Safe areas**: `globals.css` exposes `--safe-top/bottom/left/right`
  (`env(safe-area-inset-*, 0px)`). The header and the sidebar's logo
  row are `h-[calc(3.5rem+var(--safe-top))]` + `pt-[var(--safe-top)]`;
  the dashboard shell's content column and the sidebar footer pad by
  `--safe-bottom`. The inbox's fixed height is
  `calc(100dvh - 3.5rem - var(--safe-top) - var(--safe-bottom))` —
  **these three places encode the same header height and must change
  together.** All resolve to 0px in a normal browser tab, so desktop is
  visually unchanged.
- `h-screen`/`min-h-screen`/`100vh` → `h-dvh`/`min-h-dvh`/`100dvh`
  across the shell, inbox, auth pages, join layout and the automation
  editor's loading states. On mobile Safari `100vh` is the
  toolbars-hidden height, which pushed the composer off-screen; `dvh`
  tracks the visible viewport. Don't reintroduce `vh` for full-height
  layouts.
- `globals.css` also sets `overscroll-behavior-y: none` on `body`
  (kills rubber-banding; **also disables Chrome-Android
  pull-to-refresh**, intentionally — it would reload the SPA and drop
  inbox state), `-webkit-tap-highlight-color: transparent`, and
  `touch-action: manipulation` on tappable controls.
- [src/middleware.ts](src/middleware.ts) — matcher now excludes
  `manifest.webmanifest` and `sw.js` (the latter pre-emptively, for the
  service-worker phase) so the browser's PWA fetches don't pay a
  Supabase `getUser()` round trip.
- [next.config.ts](next.config.ts) — CSP (still report-only) gains
  `worker-src 'self' blob:` (covers the existing opus encoder worker
  and the future service worker).
- **The app's landing route is the Inbox, not the Dashboard.**
  [src/lib/navigation.ts](src/lib/navigation.ts)'s `DEFAULT_LANDING_PATH`
  is the single source of truth, consumed by the root route
  ([src/app/page.tsx](src/app/page.tsx)), the middleware's
  already-signed-in bounce off `/login`, the post-sign-in redirect, the
  post-invite-accept redirect, the sidebar logo link, and the
  manifest's `start_url`. Kept import-free so `src/middleware.ts` can
  use it in the Edge runtime. Every role (owner → viewer) can open the
  Inbox, so it is a safe destination for any signed-in user — if that
  changes, this constant becomes a function of the role.
  `src/middleware.test.ts` asserts against the constant, not a
  literal, so flipping it does not break the test.

Not yet done, in intended order: bottom tab bar for `<lg` (replacing
the hamburger-drawer as primary mobile nav), a minimal hand-written
`public/sw.js` (network-first, `Cache-Control: no-cache` header rule
for it in `next.config.ts` — the current `s-maxage=300` rule would
otherwise pin stale workers), then Web Push (`push_subscriptions`
table + `web-push` + VAPID env vars). Don't reach for `next-pwa`/
`serwist` — they're webpack plugins and Next 16 builds with Turbopack.

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

## 2026-08-22 — WhatsApp contact identity: dedupe by username, not just by BSUID token

Same day, third round on this issue. The user confirmed the prior
BSUID-token stopgap still isn't enough: even after **manually saving the
customer's real phone number**, a new duplicate conversation appeared
again under the same `PE.1128521366369305` code — because that token is
a rotating routing credential, not a stable identity, while
`profile.username` (e.g. `"thali.vd_"`) stays constant. Production
screenshot showed exactly this: two rows for the same customer, same
visible name, one keyed by the BSUID, one by the real phone, with no
link between them. See the rewritten **"WhatsApp contact identity"**
section above for the full three-signal model (phone / username /
routing token) this introduces.

Touched:

- [supabase/migrations/040_wa_username_identity.sql](supabase/migrations/040_wa_username_identity.sql)
  — **new migration, must be applied**: `contacts.wa_username` (+
  generated, lowercased `wa_username_normalized`) with a per-account
  unique partial index (mirrors migration 022's `phone_normalized`
  pattern exactly); `contacts.wa_user_id` (current/last-known BSUID,
  plain index, deliberately not unique — it can rotate); new
  `merge_contacts(p_survivor_id, p_loser_id)` SQL function for
  collapsing an explicit duplicate pair, `SECURITY DEFINER`, `EXECUTE`
  granted to `service_role` only.
  - **Self-caught security issue while writing this migration**: first
    draft granted `EXECUTE` to `authenticated`, which — since the
    function is `SECURITY DEFINER` and bypasses RLS — would have let
    any logged-in user of any account merge/delete contacts in any
    other account via a direct Supabase RPC call from the browser,
    bypassing the admin-role + same-account check meant to live in the
    API route. Corrected before shipping to `service_role`-only,
    matching migration 029's `claim_ai_reply_slot` precedent.
- [src/app/api/whatsapp/webhook/route.ts](src/app/api/whatsapp/webhook/route.ts)
  — `findOrCreateContact` gained `waUsername`/`waUserId` params and now
  checks `wa_username_normalized` **first**, before the phone/BSUID
  fallback; a match reuses that contact and refreshes `wa_user_id` (and
  `phone`, only when the new value actually looks like a phone) without
  creating anything new. Every resolution path — username match, phone
  fallback, and new-contact insert — also opportunistically captures
  `wa_username`/`wa_user_id` when Meta includes them, even alongside a
  real visible phone number, so a customer who later hides her number
  is already known.
  - **Bug caught by the new tests, fixed before shipping**: `wa_user_id`
    was initially written from `rawSenderId`, which resolves to the
    phone digits (not the BSUID) whenever `message.from` is present —
    so a phone-visible message that also carried a username stored the
    phone in `wa_user_id` instead of the routing token. Fixed by
    computing `waUserId` independently
    (`message.from_user_id ?? contact.user_id ?? null`, never falling
    back to `message.from`) and threading it through as its own
    parameter, distinct from `rawSenderId`.
- [src/app/api/whatsapp/webhook/route.test.ts](src/app/api/whatsapp/webhook/route.test.ts)
  — mock `contacts` table lookup generalized from a rigid two-`.eq()`
  chain to a flexible one supporting both username- and phone-based
  queries; `update()` is now a real mutation instead of a no-op, since
  correctness here depends on updates persisting across calls within a
  test. Three new tests: same username reappearing under a different
  BSUID resolves to the same contact (the exact regression reported);
  a hidden-number message matches a contact staff already linked by
  username, without touching its real phone; a username seen alongside
  a real phone gets captured opportunistically. 21/21 passing.
- [src/types/index.ts](src/types/index.ts) — `Contact` gains
  `wa_username`/`wa_user_id`.
- [src/lib/whatsapp/phone-utils.ts](src/lib/whatsapp/phone-utils.ts) —
  extracted the webhook's inline `/^\+?\d{5,15}$/` check into an
  exported `looksLikePhoneNumber`, now shared by the webhook and the
  contacts UI.
- [src/components/contacts/contact-form.tsx](src/components/contacts/contact-form.tsx),
  [src/components/contacts/contact-detail-view.tsx](src/components/contacts/contact-detail-view.tsx)
  — new "WhatsApp username" field in both the create/edit dialog and
  the Details tab, so staff can manually link a known username onto an
  existing (phone-having) contact. `contact-detail-view.tsx` also gained
  a "Merge with another contact" button opening a search-and-confirm
  dialog (`MergeContactDialog`, defined in the same file) that calls the
  new merge endpoint below — the currently-viewed contact is always the
  survivor, the picked one is deleted after its data is re-pointed.
- [src/app/api/contacts/[id]/merge/route.ts](<src/app/api/contacts/[id]/merge/route.ts>)
  — new, `admin`-role-gated: verifies both the survivor (`[id]`) and the
  posted `loser_id` belong to the caller's own account (via the
  RLS-scoped session client), then invokes `merge_contacts` through
  [src/lib/contacts/admin-client.ts](src/lib/contacts/admin-client.ts)'s
  service-role client — the only thing allowed to call a
  `service_role`-only RPC.
- [src/app/(dashboard)/contacts/page.tsx](<src/app/(dashboard)/contacts/page.tsx>)
  — the contacts list table's phone column now shows `@username` (or a
  "hidden number" fallback) instead of the raw BSUID string when
  `contact.phone` doesn't look like a real phone number, mirroring the
  detail view's existing header-chip treatment.
- `messages/en.json`, `es.json`, `ko.json` — new keys for the username
  field (form + detail view), the non-phone display badge, and the
  merge dialog, in all three locales.

Verified: `npx tsc --noEmit` clean; `npx eslint` on every touched file
(0 errors, only pre-existing unrelated warnings — unused imports/hook
deps predating this session's edits); `npx vitest run
src/i18n/messages.test.ts` (4/4, locale parity holds);
`npx vitest run src/app/api/whatsapp/webhook/route.test.ts` (21/21);
full `npx vitest run` (848/850 — only the same pre-existing, unrelated
`date-utils.test.ts` `mondayIndex` timezone flakiness). Not verified
in-browser (no Supabase login credentials available this session, same
limitation as every prior UI change this session) — manual recommended
before considering this closed: link `thali.vd_` to the phone-having
contact, use "Merge with another contact" to fold the BSUID-only
duplicate into it, then confirm the next message from that customer
(hidden number or not) lands on the single surviving contact.

> **Migration required for self-hosters:** apply
> `supabase/migrations/040_wa_username_identity.sql` before using the
> new "WhatsApp username" field or the merge feature.

**Still deliberately out of scope, unchanged from prior entries:**
outbound sending to a username-only/BSUID-only contact (`recipient`
field vs. `to`) — a distinct, not-yet-started follow-up.

## 2026-08-22 — Outbound sends via `recipient`: reply to a WhatsApp-usernames contact

Same day, fourth round. User hit this in production: replying from the
Inbox to "thali.vd_" (a hidden-number contact) failed with
`Failed to send: Invalid phone number format`, and asked whether the
username/merge work above already fixed it (it didn't — that work never
touched outbound sending) and whether her real name/phone could be
saved (already possible, unrelated to this bug). This entry ships the
`recipient`-field follow-up that every prior entry in this section
flagged as deferred.

Root cause: `contacts.phone` is `NOT NULL`, so a hidden-number contact
has its BSUID (`"PE.1128521366369305"`) parked there as a placeholder.
Every send path validated `phone` as a real E.164 number before calling
Meta and threw when it wasn't one — including a **third, previously
undocumented copy** of that guard in `src/lib/whatsapp/send-message.ts`
(the Inbox composer + public `/api/v1/messages` path) beyond the two
this file already called out in `flows/meta-send.ts` /
`automations/meta-send.ts`.

**Confirmed against Meta's own docs** (WebFetch + WebSearch this
session): the outbound body needs a `recipient` field (the BSUID)
instead of `to` (phone-only) — `{ messaging_product, recipient_type:
"individual", recipient: "PE.1128521366369305", type, ... }`. At least
one of `to`/`recipient` is required; `to` wins if both are present;
`recipient_type` stays `"individual"` either way.

Touched:

- [src/lib/whatsapp/phone-utils.ts](src/lib/whatsapp/phone-utils.ts) —
  new `RecipientTarget` union (`{type:'phone',value}` |
  `{type:'user_id',value}`) and `resolveRecipientTarget(contact)`: real
  phone → `to`; BSUID placeholder (or a phone-shaped-but-invalid value)
  with a `wa_user_id` on file → `recipient`; neither → throws. One
  helper shared by every call site below instead of re-deriving the
  branch four times.
- [src/lib/whatsapp/meta-api.ts](src/lib/whatsapp/meta-api.ts) — all 6
  send functions (`sendTextMessage`, `sendMediaMessage`,
  `sendTemplateMessage`, `sendReactionMessage`,
  `sendInteractiveButtons`, `sendInteractiveList`) take
  `recipientTarget: RecipientTarget` instead of `to: string`, and build
  the body with `...(type === 'phone' ? {to} : {recipient})`.
- [src/lib/whatsapp/send-message.ts](src/lib/whatsapp/send-message.ts)
  — priority fix (backs both the Inbox composer and the public API).
  Already had the full `Contact` row in scope, so no query widening
  needed. The phone-variant retry loop (trunk-prefix guessing) and the
  "auto-correct `contacts.phone`" write only make sense for a real
  phone — both are skipped for a `user_id` target (a BSUID has no trunk
  prefix; there's nothing to auto-correct since `wa_user_id` is
  refreshed only by the inbound webhook).
- [src/lib/flows/meta-send.ts](src/lib/flows/meta-send.ts),
  [src/lib/automations/meta-send.ts](src/lib/automations/meta-send.ts)
  — same treatment across all four engine senders (`engineSendText`,
  `engineSendMedia`, `sendInteractiveViaMeta` in Flows; `sendViaMeta` in
  Automations); each widened its `contacts` select to add `wa_user_id`.
- [src/app/api/whatsapp/react/route.ts](src/app/api/whatsapp/react/route.ts)
  — reactions, the simplest call site (no retry loop to begin with);
  widened the nested `contacts` join to include `wa_user_id`.
- [src/app/api/whatsapp/broadcast/route.ts](src/app/api/whatsapp/broadcast/route.ts),
  [src/lib/whatsapp/broadcast-core.ts](src/lib/whatsapp/broadcast-core.ts)
  — **not** given BSUID support (see below); adapted mechanically to the
  new `meta-api.ts` signature by wrapping their existing phone string in
  `{type:'phone', value}`, since changing `sendTemplateMessage`'s args
  shape broke them at the type level regardless of scope.
- Tests: `phone-utils.test.ts` (new `resolveRecipientTarget` cases),
  `meta-api.test.ts` / `meta-api.media.test.ts` (fixtures ported from
  `to` to `recipientTarget`, plus a new case per function group
  asserting a `user_id` target produces `recipient` and omits `to`
  entirely), `send-message.test.ts` (new describe block: BSUID contact
  sends via `recipient` with no `contacts.phone` write; no-`wa_user_id`
  case throws 400 before any Meta call), and **new**
  `flows/meta-send.test.ts` / `automations/meta-send.test.ts` (neither
  engine had direct test coverage before — `automations/engine.test.ts`
  mocks the whole `meta-send` module away — each new file covers the
  real-phone/unchanged-retry case, the single-call BSUID case, and the
  throws-before-any-Meta-call case), and
  `api/whatsapp/send/route.test.ts` (one pre-existing assertion on
  `args.to` updated to `args.recipientTarget`).

**Deliberately excluded — broadcasts (campaign sends).** Both broadcast
pipelines (`broadcast-core.ts`'s `deliverBroadcast`, and the dashboard's
`api/whatsapp/broadcast/route.ts`) are phone-string-driven end to end
and never query `contacts` at delivery time — there's no `wa_user_id` in
scope to route through without new schema work (threading it through
`BroadcastPlan.planned` / `broadcast_recipients`) and wizard UI changes.
Doesn't block the reported bug (1:1 replies), so left as a distinct,
not-yet-started follow-up — same as noted in every prior entry in this
section, just narrowed now that the conversational paths are done.

Verified: `npx tsc --noEmit` clean (the `to` → `recipientTarget` rename
is a breaking type change, so this caught every call site including the
two broadcast files); `npx eslint` on every touched file (0
errors/warnings); `npx vitest run` on all touched/new test files (76
passing); full `npx vitest run` (864/866 — only the same pre-existing,
unrelated `date-utils.test.ts` `mondayIndex` timezone flakiness). Not
verified against a live Meta send this session (no WhatsApp credentials
available) — manual recommended: reply from the Inbox to a contact whose
`phone` holds a BSUID placeholder (e.g. "thali.vd_") and confirm the
message delivers instead of showing "Invalid phone number format".

**Post-deploy diagnosis, same day.** The user confirmed the outbound fix
worked in one case but then hit a second, different failure for the
same contact: `Contact has no phone number or WhatsApp user id on
file` — `wa_user_id` was still `NULL` on that row despite ongoing
inbound activity. Investigation ruled out a unique-constraint collision
(no other contact had claimed that `wa_username`) and confirmed via
`git log`/`git show --stat` that all of this session's code — including
migration 040/`039b_wa_username_identity.sql`'s webhook logic — was
already committed to `origin/main` and successfully deployed on
Vercel, so it wasn't a stale-deployment issue either. Root cause
undetermined with the evidence available (most likely this one contact
row simply predated the capture logic and never got a qualifying
inbound message after deploy) — but along the way, found and fixed a
real, previously-invisible gap: **`findOrCreateContact`'s two
`contacts.update()` calls (username-match and phone/fallback branches)
never checked for an error.** Any write failure there — a constraint
conflict, anything — was completely silent, which is exactly what would
make a real instance of this class of bug undiagnosable. Both now log
`[webhook] contact update failed: <id> <message>` on failure.
Unblocked the immediate case with a one-off manual SQL backfill
(`wa_user_id = phone` for that contact) rather than a code change,
since the code's capture logic is already correct going forward.

Also flagged and rejected: the user found a third-party "BSUID
integration guide" suggesting a `business_scoped_user_id` webhook field
and treating `wa_id`/phone as always-present. Both contradict this
project's own two independent confirmations (a real captured payload
from an affected account, and Meta's official docs via WebFetch this
session) that the real fields are `contacts[].user_id` /
`messages[].from_user_id`, and that `wa_id`/`message.from` are
**absent entirely** for a hidden-number sender. Not applied.

## 2026-08-23 — AI assistant now sees the CRM's name/phone on file

User asked whether the AI agent could check the CRM before replying, so
it stops asking a returning customer for their name/phone when the
contact record already has them saved.

Previously, `buildConversationContext` (both the auto-reply bot and the
inbox "draft" button) fed the model nothing but the raw WhatsApp
message transcript plus knowledge-base excerpts — no query against
`contacts` at all, so the model had zero way to know a customer's name,
phone, or whether they'd written in before, unless that information
happened to appear literally inside the chat text.

Touched:

- [src/lib/ai/context.ts](src/lib/ai/context.ts) — new
  `buildCustomerContext(db, conversationId, contactId)`: looks up
  `contacts.name`/`phone` plus a `isReturningCustomer` flag (more than
  one customer-sent message already in this conversation — this CRM
  reuses/reopens one conversation per contact rather than starting a
  fresh thread per session, the same signal the webhook already uses
  for the `first_inbound_message` automation trigger). Deliberately
  never returns a WhatsApp-usernames BSUID placeholder as `phone` —
  gated on the existing `looksLikePhoneNumber` helper — since handing
  the model a string like `"PE.1128521366369305"` and calling it "the
  customer's phone number" would be actively wrong, not just unhelpful.
- [src/lib/ai/defaults.ts](src/lib/ai/defaults.ts) — `buildSystemPrompt`
  gained an optional `customer: CustomerContext | null` param. When any
  of its fields are truthy, adds a "Customer record" paragraph — e.g.
  "this is a returning customer... Already on file — do not ask the
  customer for this again: name: X, phone number: Y." Omitted entirely
  when there's nothing to report (a fresh contact captured mid-session,
  no name/phone yet, not returning), rather than printing an
  empty-handed sentence every time.
- [src/lib/ai/auto-reply.ts](src/lib/ai/auto-reply.ts),
  [src/app/api/ai/draft/route.ts](src/app/api/ai/draft/route.ts) — both
  call `buildCustomerContext` right after `buildConversationContext`
  and thread it into `buildSystemPrompt`. The draft route's
  `conversations` select widened from `id` to `id, contact_id` to have
  a contact to look up (previously never fetched one).
  `api/ai/playground/route.ts` deliberately untouched — it's a
  stateless test chat with no real conversation/contact behind it.
- Tests: `context.test.ts` (new `buildCustomerContext` cases, including
  the BSUID-placeholder-never-becomes-a-phone-number case),
  `defaults.test.ts` (new file — the customer-record paragraph's
  presence/omission rules), `auto-reply.test.ts` (mocked
  `buildCustomerContext`, since the module mock previously only
  exported `buildConversationContext` and would otherwise have made
  every existing test call `undefined()`; one new test asserting the
  system prompt carries the name/phone/returning-customer info through).

No DB migration needed — reads existing `contacts` columns only.
Verified: `npx tsc --noEmit` clean; `npx eslint` on every touched file
(0 errors/warnings); `npx vitest run` on the touched/new files (29
passing); full `npx vitest run` (875/877 — only the same pre-existing,
unrelated `date-utils.test.ts` `mondayIndex` timezone flakiness). Not
verified against a live LLM call this session (no provider key
available) — manual recommended: with an AI config active, message in
as a contact who already has a name + real phone saved, and confirm the
draft/auto-reply doesn't ask for information already on file.

## 2026-08-23 — Voice-note transcription + provider-aware auxiliary key routing

User asked whether the AI agent can understand a voice note a customer
sends. Confirmed nothing did this yet (`buildConversationContext`
excluded `content_type='audio'` at the SQL level; the webhook never
wrote `content_text` for audio) and that the upstream repo
(`ArnasDon/wacrm`) has no prior art either — its own audio-related
PRs/issues (#496, #467, #262, #259, #213, #201, #14) are all about
recording/sending/displaying voice notes, never about the AI
understanding them.

First design assumed a dedicated OpenAI-only key, mirroring
`embeddings.ts`'s existing pattern. The user corrected this: they use
**OpenRouter**, which lets you declare any underlying model (including
OpenAI's) for a given task — so instead of a new key, the existing
OpenRouter key should just work, with a declarable model. Confirmed via
WebFetch/WebSearch against OpenRouter's own docs/blog: OpenRouter now
exposes both `/api/v1/audio/transcriptions` and `/api/v1/embeddings`,
OpenAI-wire-compatible, using the **same key** as chat completions —
so this became a broader fix than just transcription (the user
explicitly asked to apply the same idea to embeddings, which had been
OpenAI-only since it shipped).

Touched:

- [src/lib/ai/config.ts](src/lib/ai/config.ts) — new
  `AuxiliaryEndpoint` type + `resolveAuxiliaryEndpoint`: given the
  account's provider/main key, resolves where to send an auxiliary
  (embeddings/transcription) request — `api.openai.com` direct for
  `provider: 'openai'`, `openrouter.ai/api/v1` (same key, vendor-
  prefixed model) for `provider: 'openrouter'`, and a dedicated
  fallback key (only path for Anthropic) otherwise — with the fallback
  key always taking precedence when configured, so an account that set
  one up before this existed sees no behavior change. New
  `loadEmbeddingsEndpoint` (replaces `loadEmbeddingsKey`, same
  `is_active`-independent contract, now returns `{endpoint, corrupt}`),
  `deriveEmbeddingsEndpoint` (sync, from an already-loaded `AiConfig` —
  avoids a second DB round trip in draft/auto-reply/playground), and
  `loadTranscriptionEndpoint` (new, used only by the webhook).
- [src/lib/ai/embeddings.ts](src/lib/ai/embeddings.ts) — `embedTexts`
  takes an `AuxiliaryEndpoint` instead of a bare API key; URL and model
  come from the resolved endpoint instead of a hardcoded OpenAI
  constant. Added a dimension check (embedding response must be
  exactly 1536-dim, matching migration 030's `vector(1536)` column) so
  a bad model id fails loud at the API boundary instead of corrupting
  the KB or erroring opaquely at insert time.
- [src/lib/ai/knowledge.ts](src/lib/ai/knowledge.ts) — `ingestDocument`/
  `retrieveKnowledge` take `AuxiliaryEndpoint | null` instead of
  `Pick<AiConfig,'embeddingsApiKey'>`; the semantic-path gate is now
  "is there a resolved endpoint" rather than "is a key configured" —
  6 call sites updated: the 3 knowledge routes (now call
  `loadEmbeddingsEndpoint`) and draft/auto-reply/playground (now call
  `deriveEmbeddingsEndpoint(config)`, no extra query since they already
  hold a loaded `AiConfig`).
- [src/lib/ai/transcription.ts](src/lib/ai/transcription.ts) — new,
  `transcribeAudio`: POSTs multipart/form-data to
  `<endpoint.baseUrl>/audio/transcriptions`. Never throws (every
  failure — network, non-2xx, malformed response, >25MB buffer — logs
  and returns `null`), unlike `embedTexts`, since a transcription
  failure must never break inbound message ingestion. Confirmed OGG
  (WhatsApp's voice-note format) is accepted directly by both OpenAI
  and OpenRouter — no server-side conversion/`ffmpeg` needed (this
  project deliberately removed server-side ffmpeg for voice notes in
  an earlier PR).
- [src/app/api/whatsapp/webhook/route.ts](src/app/api/whatsapp/webhook/route.ts)
  — `parseMessageContent` gained an unconditional `accountId` param
  (previously only threaded through conditionally, inside the
  media-mirror opt-out object); its `audio` case now calls
  `loadTranscriptionEndpoint` and, when resolved, downloads the voice
  note via `getMediaUrl`/`downloadMedia` (deliberately NOT via
  `media_url` — that can be a relative, non-fetchable proxy path when
  the account has media mirroring disabled) and sets `content_text` to
  the transcript.
- [src/lib/ai/context.ts](src/lib/ai/context.ts) —
  `buildConversationContext`'s filter widened from
  `.eq('content_type', 'text')` to
  `.in('content_type', ['text', 'audio'])` — a transcribed voice note
  now feeds the AI's context the same as a typed message; an audio row
  with no transcript is still dropped by the existing empty-text filter.
- [src/components/inbox/message-bubble.tsx](src/components/inbox/message-bubble.tsx)
  — the `case "audio":` block now shows a "Transcript" chip + italic
  text below the audio player when `content_text` is present.
- [src/components/settings/ai-config.tsx](src/components/settings/ai-config.tsx),
  [src/app/api/ai/config/route.ts](src/app/api/ai/config/route.ts) —
  new transcription fallback-key field + free-text model-override
  field, mirroring the embeddings key's UI/API treatment exactly; the
  embeddings key's hint text updated to explain it's now only needed
  for Anthropic. No live "Test key" button for transcription (see the
  new CLAUDE.md section above for why). `handleRemove` (DELETE) now
  also resets the embeddings/transcription key UI state — previously
  didn't, a small pre-existing gap fixed in passing since I was already
  touching that function.
- [supabase/migrations/040_transcription_key.sql](supabase/migrations/040_transcription_key.sql)
  — **new migration, must be applied**: `ai_configs.transcription_api_key`
  (encrypted fallback key) + `ai_configs.transcription_model` (free-text
  override).
- `messages/en.json`, `es.json`, `ko.json` — new keys for the
  transcription field/model/hint, the Inbox transcript chip, and the
  updated embeddings hint text.
- Tests: `config.test.ts` (new `resolveAuxiliaryEndpoint` coverage via
  `loadEmbeddingsEndpoint`/`deriveEmbeddingsEndpoint`/
  `loadTranscriptionEndpoint` — every provider + fallback-key
  precedence + corrupt-key handling), `embeddings.test.ts` (ported to
  `AuxiliaryEndpoint`, new dimension-mismatch case),
  `knowledge.test.ts` (ported to `AuxiliaryEndpoint | null`),
  `context.test.ts` (fake DB chain gained `.in()`), new
  `transcription.test.ts` (success, HTTP error, malformed response,
  network error, oversized buffer skipped before any fetch, model
  passed through), new cases in
  `webhook/route.test.ts` (audio message + configured key → transcript
  in `content_text`; no key configured → unchanged `null` behavior).

Verified: `npx tsc --noEmit` clean (the `embedTexts`/`ingestDocument`/
`retrieveKnowledge` signature changes are disruptive at the type level,
so this caught every call site); `npx eslint` on every touched file (0
errors, 1 pre-existing unrelated warning); `npx vitest run
src/i18n/messages.test.ts` (4/4); full `npx vitest run` (897/899 — only
the same pre-existing, unrelated `date-utils.test.ts` `mondayIndex`
timezone flakiness). Not verified against a live transcription/
embeddings call this session (no provider key available) — manual
recommended: with an OpenRouter (or OpenAI) chat key already configured
and NO transcription/embeddings key entered, send a voice note and
confirm the Inbox shows a transcript, and separately confirm the
knowledge base's semantic search still works without ever having
entered an embeddings key.

> **Migration required for self-hosters:** apply
> `supabase/migrations/040_transcription_key.sql` before voice notes
> will transcribe (only needed if you want transcription at all — the
> feature is fully opt-in and inert without it).

## 2026-08-23 — Stop overwriting a contact's name on every subsequent message

User reported (with a screenshot) that a contact they'd manually named
"Mario" showed up renamed to "mariof737" — the customer's raw WhatsApp
@handle — after writing in again. The two things the user actually
asked to have checked (the AI consulting the CRM before asking for
name/phone again, and resolving a hidden-number message by username
when the BSUID token rotates) were **already shipped** in earlier
sessions (`buildCustomerContext`, `src/lib/ai/context.ts`; the
username-first branch in `findOrCreateContact`). The screenshot
exposed a separate, real bug in that same function.

Root cause: both of `findOrCreateContact`'s existing-contact branches
(username-match and phone/BSUID-fallback) unconditionally overwrote
`contacts.name` whenever the freshly-computed `name` (which prefers
`contact.profile.username` over `profile.name` — see the "WhatsApp
contact identity" section above) differed from what was already
stored:

```ts
if (name && name !== byUsername.name) update.name = name
// ...
if (name && name !== existingContact.name) update.name = name
```

Since a manually-set real name almost never matches the customer's raw
@handle, this fired on essentially every inbound message from a
username-having customer, silently discarding whatever staff had typed
in.

Touched:

- [src/app/api/whatsapp/webhook/route.ts](src/app/api/whatsapp/webhook/route.ts)
  — both conditions narrowed to `name && !byUsername.name` /
  `name && !existingContact.name`: a name is now only ever filled in
  when the contact doesn't have one yet, never overwritten once set.
  `wa_username`/`wa_user_id` capture and the real-phone-showed-up
  `phone` update are untouched — only the display name is protected.
  New-contact creation (`insert`) is unaffected — `name || lookupKey`
  is still the right initial value there, since there's nothing to
  protect yet.
- [src/app/api/whatsapp/webhook/route.test.ts](src/app/api/whatsapp/webhook/route.test.ts)
  — added a `.name` assertion to the existing
  `'matches a hidden-number message to a contact staff already linked
  by username'` test (it reproduced this exact scenario without
  checking the field that broke) as a permanent regression guard, and
  a new test covering the same guard on the phone/BSUID-fallback
  branch (a "Mario"-named contact keeps its name after a message
  carrying `username: 'mariof737'`, while `wa_username` still gets
  captured).

No DB migration needed. Verified: `npx tsc --noEmit` clean; `npx
eslint` on the touched files (0 errors); `npx vitest run
src/app/api/whatsapp/webhook/route.test.ts` (24/24); full `npx vitest
run` (898/900 — only the same pre-existing, unrelated
`date-utils.test.ts` `mondayIndex` timezone flakiness). Not verified
against a live inbound message this session — manual recommended: with
"Mario"'s contact record intact, have that same customer (or any
contact with a manually-set name and a linked/known WhatsApp username)
message in again and confirm the name in Contacts/Inbox stays
unchanged.

**Not investigated this session, flagged by the user in passing:** a
server error log (`Error in WhatsApp media GET: ... Object with ID
'...' does not exist...`) pasted alongside the name-overwrite report.
Deferred at the user's own request — unclear whether it's new
(possibly related to transcription's extra `getMediaUrl` call per
voice note) or a pre-existing occasional failure; needs its own
investigation.

## 2026-09-12 — PWA phases 0+1: installable, standalone-safe layout

User asked how to make the app feel like an installable mobile app
instead of "a website on a phone", without breaking anything. Audit
found no PWA foundation at all (no manifest, no service worker, no
install icons, `themeColor` hardcoded dark, no safe-area handling,
`100vh`-based full-height layouts) plus hamburger-drawer navigation
as the only mobile nav. Agreed on a five-phase plan (0: installable;
1: standalone-safe layout; 2: bottom tab bar; 3: minimal service
worker + update toast; 4: Web Push) and shipped phases 0 and 1 in
this session — see the new **PWA / installed-app baseline** section
above for the durable description of what exists now.

Touched:

- [src/app/manifest.ts](src/app/manifest.ts) — new.
- `public/icons/` — 4 new PNGs generated with `sharp` from the
  `icon.tsx` brand mark (script was run once from the repo root and
  not committed; CRLF/`NODE_PATH` gotcha: scripts in the scratchpad
  can't resolve `node_modules`, run them from the repo).
- [src/lib/themes.ts](src/lib/themes.ts) — `THEME_COLOR_BY_MODE`.
- [src/app/layout.tsx](src/app/layout.tsx) — `viewport` (`width`,
  `initialScale`, `viewportFit`, `interactiveWidget`, media-keyed
  `themeColor`), `metadata.appleWebApp`, `metadata.icons.apple`.
- [src/hooks/use-theme.tsx](src/hooks/use-theme.tsx) — theme-color
  meta sync effect.
- [src/app/globals.css](src/app/globals.css) — safe-area variables,
  tap-highlight, overscroll, touch-action block appended at the end.
- [src/app/(dashboard)/dashboard-shell.tsx](<src/app/(dashboard)/dashboard-shell.tsx>),
  [src/components/layout/header.tsx](src/components/layout/header.tsx),
  [src/components/layout/sidebar.tsx](src/components/layout/sidebar.tsx),
  [src/app/(dashboard)/inbox/page.tsx](<src/app/(dashboard)/inbox/page.tsx>)
  — `dvh` + safe-area padding (see the section above for the
  three-places-in-sync rule on the header height).
- [src/app/(dashboard)/automations/[id]/edit/page.tsx](<src/app/(dashboard)/automations/[id]/edit/page.tsx>),
  the three `(auth)` pages, [src/app/join/layout.tsx](src/app/join/layout.tsx)
  — mechanical `h-screen`/`min-h-screen` → `dvh`.
- [src/middleware.ts](src/middleware.ts) — matcher exclusions;
  [next.config.ts](next.config.ts) — `worker-src`.

Same session, follow-up: the app now opens on the **Inbox** instead of
the Dashboard. The user asked for this right after phases 0+1 — on a
phone the app is opened to answer a customer, not to read charts, and
the manifest's `start_url` already pointed at `/inbox`, so the four
redirect points disagreed with it. Introduced
[src/lib/navigation.ts](src/lib/navigation.ts) (`DEFAULT_LANDING_PATH`)
rather than editing five literals, and pointed the sidebar logo at it
too so "home" means one thing everywhere. `/dashboard` is unchanged
and still reachable from the nav.

No DB migration, no i18n keys, no dependency added. Verified:
`npx tsc --noEmit` clean; `npx eslint` on every touched file (0
errors, 3 pre-existing warnings on untouched lines); full `npx vitest
run` (898/900 — only the same pre-existing `date-utils.test.ts`
timezone failures); `next build` succeeds and lists
`○ /manifest.webmanifest`; `next start` + `curl` confirmed the
manifest JSON (`application/manifest+json`), the `viewport` meta with
`viewport-fit=cover, interactive-widget=resizes-content`, both
`theme-color` tags, the `apple-touch-icon`/`apple-mobile-web-app-*`
tags, and `200 image/png` for the icons. Not verified on a real
device — manual recommended before considering this closed: open the
deployed URL on Android Chrome (expect the install prompt / "Install
app" menu entry) and on iPhone Safari (Share → Add to Home Screen),
launch from the home screen, and confirm (a) no browser bar, (b) the
header sits below the status bar / notch, (c) the inbox composer sits
above the home indicator and rises with the keyboard, (d) switching
light/dark in-app recolors the Android status bar. Tailwind's
`h-dvh` needs iOS 15.4+ / Chrome 108+, which every current phone has.
