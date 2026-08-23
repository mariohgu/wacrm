import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, AiProvider } from './types'

interface AiConfigRow {
  provider: 'openai' | 'anthropic' | 'openrouter'
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
  }
}

// ============================================================
// Auxiliary OpenAI-only capabilities (embeddings, audio transcription).
//
// Both need an OpenAI-compatible endpoint, but the account may not have
// a raw OpenAI key at all — they might be on OpenAI, Anthropic, or
// OpenRouter as their main chat provider. OpenRouter is wire-compatible
// with OpenAI for these two endpoints too (same request shape, just a
// different base URL and vendor-prefixed model id), so an account on
// OpenAI *or* OpenRouter can use the SAME key it already configured —
// no second key needed. Only Anthropic has neither endpoint, so that's
// the one case that still needs a dedicated fallback key.
//
// Precedence: an explicitly-configured fallback key always wins over
// auto-routing, so an account that already set one up (before this
// existed) keeps behaving exactly as before.
// ============================================================

export interface AuxiliaryEndpoint {
  baseUrl: string
  apiKey: string
  model: string
}

const OPENAI_API_BASE = 'https://api.openai.com/v1'
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1'

function resolveAuxiliaryEndpoint(args: {
  provider: AiProvider
  mainApiKey: string
  fallbackKey: string | null
  modelOverride: string | null
  defaultOpenAiModel: string
  defaultOpenRouterModel: string
}): AuxiliaryEndpoint | null {
  const {
    provider,
    mainApiKey,
    fallbackKey,
    modelOverride,
    defaultOpenAiModel,
    defaultOpenRouterModel,
  } = args
  if (fallbackKey) {
    return {
      baseUrl: OPENAI_API_BASE,
      apiKey: fallbackKey,
      model: modelOverride || defaultOpenAiModel,
    }
  }
  if (provider === 'openai') {
    return {
      baseUrl: OPENAI_API_BASE,
      apiKey: mainApiKey,
      model: modelOverride || defaultOpenAiModel,
    }
  }
  if (provider === 'openrouter') {
    return {
      baseUrl: OPENROUTER_API_BASE,
      apiKey: mainApiKey,
      model: modelOverride || defaultOpenRouterModel,
    }
  }
  return null // anthropic with no fallback key configured — no capability
}

/** Best-effort decrypt — a corrupt/mismatched-key value degrades to
 *  "not usable" rather than throwing into a caller that expects a
 *  graceful `null`. Logs so a rotated ENCRYPTION_KEY doesn't fail
 *  silently forever. */
function tryDecrypt(value: string, label: string, accountId: string): string | null {
  try {
    return decrypt(value)
  } catch {
    console.error(
      `[ai config] ${label} for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return null
  }
}

// Kept in sync with embeddings.ts's EMBEDDING_MODEL/EMBEDDING_DIMENSIONS
// contract (1536-dim, matches the `vector(1536)` column in migration
// 030) — not imported from there to avoid a circular import between
// this file and embeddings.ts.
const EMBEDDINGS_DEFAULT_OPENAI_MODEL = 'text-embedding-3-small'
const EMBEDDINGS_DEFAULT_OPENROUTER_MODEL = 'openai/text-embedding-3-small'

/**
 * Resolve the embeddings endpoint for an account, querying the DB
 * directly. Used by the knowledge-base ingest/reindex routes, which
 * don't otherwise load a full `AiConfig`. Independent of `is_active` —
 * the KB should stay embedded/searchable even if the assistant's
 * master switch is off, same as the old `loadEmbeddingsKey` this
 * replaces.
 *
 * No model override here (unlike transcription) — the KB's vectors are
 * anchored to a fixed 1536-dim column, so letting an account pick an
 * arbitrary embeddings model would risk a dimension mismatch.
 *
 * Returns `corrupt: true` only when a fallback key was explicitly
 * configured but couldn't be decrypted — same diagnostic the old
 * `loadEmbeddingsKey` exposed, so callers can still warn "saved with
 * keyword search only, re-enter your key" instead of just silently
 * downgrading.
 */
export async function loadEmbeddingsEndpoint(
  db: SupabaseClient,
  accountId: string,
): Promise<{ endpoint: AuxiliaryEndpoint | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('provider, api_key, embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return { endpoint: null, corrupt: false }

  let corrupt = false
  let fallbackKey: string | null = null
  if (data.embeddings_api_key) {
    fallbackKey = tryDecrypt(data.embeddings_api_key, 'embeddings key', accountId)
    corrupt = !fallbackKey
  }

  const endpoint = resolveAuxiliaryEndpoint({
    provider: data.provider,
    mainApiKey: tryDecrypt(data.api_key, 'API key', accountId) ?? '',
    fallbackKey,
    modelOverride: null,
    defaultOpenAiModel: EMBEDDINGS_DEFAULT_OPENAI_MODEL,
    defaultOpenRouterModel: EMBEDDINGS_DEFAULT_OPENROUTER_MODEL,
  })
  return { endpoint, corrupt }
}

/**
 * Same resolution as `loadEmbeddingsEndpoint`, but derived from an
 * already-loaded `AiConfig` — used by draft/auto-reply/playground,
 * which have one in hand already, so this avoids a second DB round
 * trip on the hot reply path.
 */
export function deriveEmbeddingsEndpoint(config: AiConfig): AuxiliaryEndpoint | null {
  return resolveAuxiliaryEndpoint({
    provider: config.provider,
    mainApiKey: config.apiKey,
    fallbackKey: config.embeddingsApiKey,
    modelOverride: null,
    defaultOpenAiModel: EMBEDDINGS_DEFAULT_OPENAI_MODEL,
    defaultOpenRouterModel: EMBEDDINGS_DEFAULT_OPENROUTER_MODEL,
  })
}

const TRANSCRIPTION_DEFAULT_OPENAI_MODEL = 'gpt-4o-mini-transcribe'
const TRANSCRIPTION_DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini-transcribe'

/**
 * Resolve the audio-transcription endpoint for an account, querying
 * the DB directly (the inbound webhook has no `AiConfig` in hand and
 * transcription must run independent of `is_active` — it's enrichment
 * data for the Inbox/automations/Flows, not "the AI replying").
 *
 * Unlike embeddings, a model override is honored here — transcription
 * output is plain text with no storage-format constraint, so there's
 * no dimension-mismatch risk in letting an account pick e.g.
 * `gpt-4o-transcribe` over the cost-efficient default.
 */
export async function loadTranscriptionEndpoint(
  db: SupabaseClient,
  accountId: string,
): Promise<AuxiliaryEndpoint | null> {
  const { data, error } = await db
    .from('ai_configs')
    .select('provider, api_key, transcription_api_key, transcription_model')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return null

  return resolveAuxiliaryEndpoint({
    provider: data.provider,
    mainApiKey: tryDecrypt(data.api_key, 'API key', accountId) ?? '',
    fallbackKey: data.transcription_api_key
      ? tryDecrypt(data.transcription_api_key, 'transcription key', accountId)
      : null,
    modelOverride: data.transcription_model ?? null,
    defaultOpenAiModel: TRANSCRIPTION_DEFAULT_OPENAI_MODEL,
    defaultOpenRouterModel: TRANSCRIPTION_DEFAULT_OPENROUTER_MODEL,
  })
}
