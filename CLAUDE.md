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
