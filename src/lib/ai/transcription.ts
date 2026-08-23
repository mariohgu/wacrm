import type { AuxiliaryEndpoint } from './config'
import { aiRequestTimeoutMs } from './defaults'
import { extensionForMime } from '@/lib/media/filename'

// ============================================================
// Audio transcription (OpenAI-compatible /audio/transcriptions).
//
// Transcribes an inbound WhatsApp voice note to text so it can feed
// both the Inbox display and the AI assistant's conversation context
// (see src/app/api/whatsapp/webhook/route.ts's audio case, and
// src/lib/ai/context.ts's buildConversationContext). The caller
// resolves WHERE to send the request via `config.ts`'s
// `loadTranscriptionEndpoint` — same OpenAI-or-OpenRouter routing as
// embeddings, see that file's `resolveAuxiliaryEndpoint`.
//
// Unlike embeddings/chat, this endpoint takes multipart/form-data, not
// JSON — the file is fetched as a Buffer by the caller (the webhook,
// via Meta's getMediaUrl/downloadMedia) and handed to us directly.
//
// Best-effort by design, unlike embedTexts: a transcription failure
// (network, oversized file, bad key, provider outage) must never break
// inbound message ingestion. Every failure path logs and returns null.
// ============================================================

// OpenAI's hard cap for the transcriptions endpoint.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export async function transcribeAudio(args: {
  endpoint: AuxiliaryEndpoint
  audioBuffer: Buffer
  mimeType?: string | null
}): Promise<string | null> {
  const { endpoint, audioBuffer, mimeType } = args

  if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
    console.warn(
      `[transcription] audio buffer (${audioBuffer.byteLength} bytes) exceeds the ${MAX_AUDIO_BYTES}-byte cap — skipping.`,
    )
    return null
  }

  const ext = extensionForMime(mimeType)
  // extensionForMime falls back to "bin" for an unknown/missing MIME —
  // WhatsApp voice notes are always Opus-in-Ogg, so that specific
  // fallback is wrong here; use "ogg" instead.
  const filename = `voice-note.${ext === 'bin' ? 'ogg' : ext}`

  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(audioBuffer)], { type: mimeType || 'audio/ogg' }),
    filename,
  )
  form.append('model', endpoint.model)

  let res: Response
  try {
    res = await fetch(`${endpoint.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        // No Content-Type set — fetch derives the multipart boundary
        // from the FormData body automatically.
      },
      body: form,
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    })
  } catch (err) {
    console.error(
      '[transcription] network error:',
      err instanceof Error ? err.message : err,
    )
    return null
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(
      `[transcription] provider returned ${res.status}: ${body.slice(0, 500)}`,
    )
    return null
  }

  const data = (await res.json().catch(() => null)) as { text?: string } | null
  const text = data?.text?.trim()
  if (!text) {
    console.error('[transcription] response had no text field')
    return null
  }
  return text
}
