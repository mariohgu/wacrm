import { AiError } from './types'
import type { AuxiliaryEndpoint } from './config'
import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Embeddings (OpenAI-compatible).
//
// Used for the knowledge base's optional semantic-search path: embed
// each chunk at ingest, and embed the query at retrieval. The caller
// resolves WHERE to send the request (OpenAI direct, OpenRouter using
// the account's main key, or a dedicated fallback key for Anthropic
// accounts) via `config.ts`'s `loadEmbeddingsEndpoint`/
// `deriveEmbeddingsEndpoint` — this module just calls whatever
// `AuxiliaryEndpoint` it's given. 1536-dim text-embedding-3-small
// matches the `vector(1536)` column in migration 030; see the
// dimension check in `embedTexts` below.
// ============================================================

export const EMBEDDING_MODEL = 'text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536

// OpenAI accepts an array input; keep batches modest so a big re-index
// stays under request-size limits and partial failures are cheap.
const BATCH_SIZE = 96

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[]
}

/** Format a vector for a pgvector column / RPC param: `[0.1,0.2,...]`.
 *  PostgREST casts this text literal to `vector`; a raw JS array does
 *  not cast reliably. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Embed a list of strings, preserving input order. Batched; throws
 * `AiError` on provider/network failure so callers can decide whether
 * to degrade (retrieval) or surface (ingest).
 */
export async function embedTexts(
  endpoint: AuxiliaryEndpoint,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)

    let res: Response
    try {
      res = await fetch(`${endpoint.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: endpoint.model, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (!res.ok) {
      throw await providerHttpError('Embeddings', res)
    }

    const data = (await res.json().catch(() => null)) as EmbeddingResponse | null
    const rows = data?.data
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      })
    }

    // Sort by index so order matches the input batch regardless of how
    // the provider returns them. Require a real numeric index — defaulting
    // a missing one to 0 would silently misalign chunks with their
    // vectors (chunk N gets chunk M's embedding), so fail loud instead.
    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError('Embeddings response was missing result indices.', {
        code: 'embeddings_malformed',
      })
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!)
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        })
      }
      // A mistyped model id (or a future provider default drifting) could
      // silently return a differently-sized vector — catch it here,
      // before it reaches the fixed-width `vector(1536)` column, rather
      // than as an opaque Postgres error at insert time.
      if (r.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new AiError(
          `Embeddings response returned a ${r.embedding.length}-dim vector, expected ${EMBEDDING_DIMENSIONS}. Check the configured model.`,
          { code: 'embeddings_dimension_mismatch' },
        )
      }
      out.push(r.embedding)
    }
  }

  return out
}
