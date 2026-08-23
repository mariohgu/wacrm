import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext,
// except for a sentinel value used to exercise the corrupt-key path.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v === 'corrupt-cipher') throw new Error('bad ciphertext')
    return `plain:${v}`
  },
}))

import {
  loadAiConfig,
  loadEmbeddingsEndpoint,
  deriveEmbeddingsEndpoint,
  loadTranscriptionEndpoint,
} from './config'
import type { AiConfig } from './types'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadEmbeddingsEndpoint', () => {
  it('routes to OpenAI direct with the main key when provider is openai', async () => {
    const { endpoint, corrupt } = await loadEmbeddingsEndpoint(
      dbReturning({ provider: 'openai', api_key: 'main-key', embeddings_api_key: null }),
      'acct',
    )
    expect(endpoint).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'plain:main-key',
      model: 'text-embedding-3-small',
    })
    expect(corrupt).toBe(false)
  })

  it('routes to OpenRouter with the main key and a vendor-prefixed model when provider is openrouter', async () => {
    const { endpoint } = await loadEmbeddingsEndpoint(
      dbReturning({ provider: 'openrouter', api_key: 'main-key', embeddings_api_key: null }),
      'acct',
    )
    expect(endpoint).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'plain:main-key',
      model: 'openai/text-embedding-3-small',
    })
  })

  it('returns null for anthropic with no fallback key configured', async () => {
    const { endpoint, corrupt } = await loadEmbeddingsEndpoint(
      dbReturning({ provider: 'anthropic', api_key: 'main-key', embeddings_api_key: null }),
      'acct',
    )
    expect(endpoint).toBeNull()
    expect(corrupt).toBe(false)
  })

  it('uses the fallback key (OpenAI direct) for anthropic when configured', async () => {
    const { endpoint } = await loadEmbeddingsEndpoint(
      dbReturning({
        provider: 'anthropic',
        api_key: 'main-key',
        embeddings_api_key: 'fallback-key',
      }),
      'acct',
    )
    expect(endpoint).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'plain:fallback-key',
      model: 'text-embedding-3-small',
    })
  })

  it('prefers an explicitly-configured fallback key over auto-routing, even on openai/openrouter', async () => {
    const { endpoint } = await loadEmbeddingsEndpoint(
      dbReturning({
        provider: 'openrouter',
        api_key: 'main-key',
        embeddings_api_key: 'fallback-key',
      }),
      'acct',
    )
    expect(endpoint).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'plain:fallback-key',
      model: 'text-embedding-3-small',
    })
  })

  it('reports corrupt:true and falls through when the fallback key cannot be decrypted', async () => {
    const { endpoint, corrupt } = await loadEmbeddingsEndpoint(
      dbReturning({
        provider: 'anthropic',
        api_key: 'main-key',
        embeddings_api_key: 'corrupt-cipher',
      }),
      'acct',
    )
    expect(corrupt).toBe(true)
    expect(endpoint).toBeNull() // anthropic, no usable fallback left
  })

  it('returns endpoint:null, corrupt:false when there is no row', async () => {
    const { endpoint, corrupt } = await loadEmbeddingsEndpoint(dbReturning(null), 'acct')
    expect(endpoint).toBeNull()
    expect(corrupt).toBe(false)
  })
})

describe('deriveEmbeddingsEndpoint', () => {
  const baseConfig: AiConfig = {
    provider: 'openai',
    model: 'gpt-x',
    apiKey: 'main-key',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
  }

  it('routes to OpenAI direct from an already-loaded config, no DB call needed', () => {
    const endpoint = deriveEmbeddingsEndpoint(baseConfig)
    expect(endpoint).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'main-key',
      model: 'text-embedding-3-small',
    })
  })

  it('returns null for anthropic with no embeddingsApiKey', () => {
    const endpoint = deriveEmbeddingsEndpoint({ ...baseConfig, provider: 'anthropic' })
    expect(endpoint).toBeNull()
  })
})

describe('loadTranscriptionEndpoint', () => {
  it('routes to OpenAI direct with the default transcription model', async () => {
    const { baseUrl, apiKey, model } = (await loadTranscriptionEndpoint(
      dbReturning({
        provider: 'openai',
        api_key: 'main-key',
        transcription_api_key: null,
        transcription_model: null,
      }),
      'acct',
    ))!
    expect(baseUrl).toBe('https://api.openai.com/v1')
    expect(apiKey).toBe('plain:main-key')
    expect(model).toBe('gpt-4o-mini-transcribe')
  })

  it('honors a user-configured model override through OpenRouter', async () => {
    const endpoint = await loadTranscriptionEndpoint(
      dbReturning({
        provider: 'openrouter',
        api_key: 'main-key',
        transcription_api_key: null,
        transcription_model: 'openai/gpt-4o-transcribe',
      }),
      'acct',
    )
    expect(endpoint).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'plain:main-key',
      model: 'openai/gpt-4o-transcribe',
    })
  })

  it('returns null for anthropic with no fallback key', async () => {
    const endpoint = await loadTranscriptionEndpoint(
      dbReturning({
        provider: 'anthropic',
        api_key: 'main-key',
        transcription_api_key: null,
        transcription_model: null,
      }),
      'acct',
    )
    expect(endpoint).toBeNull()
  })
})
