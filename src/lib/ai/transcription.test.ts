import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio } from './transcription'
import type { AuxiliaryEndpoint } from './config'

const TEST_ENDPOINT: AuxiliaryEndpoint = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-x',
  model: 'gpt-4o-mini-transcribe',
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
afterEach(() => vi.unstubAllGlobals())

describe('transcribeAudio', () => {
  it('returns the transcript text on a 200 response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hola, necesito ayuda' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await transcribeAudio({
      endpoint: TEST_ENDPOINT,
      audioBuffer: Buffer.from('fake audio bytes'),
      mimeType: 'audio/ogg',
    })
    expect(out).toBe('hola, necesito ayuda')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer sk-x')
    expect(opts.body).toBeInstanceOf(FormData)
    // fetch must derive the multipart boundary itself.
    expect((opts.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('returns null (does not throw) on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => 'invalid api key',
      })),
    )
    const out = await transcribeAudio({
      endpoint: TEST_ENDPOINT,
      audioBuffer: Buffer.from('x'),
    })
    expect(out).toBeNull()
  })

  it('returns null on malformed JSON / missing text field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ no_text_here: true }),
      })),
    )
    const out = await transcribeAudio({
      endpoint: TEST_ENDPOINT,
      audioBuffer: Buffer.from('x'),
    })
    expect(out).toBeNull()
  })

  it('returns null on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const out = await transcribeAudio({
      endpoint: TEST_ENDPOINT,
      audioBuffer: Buffer.from('x'),
    })
    expect(out).toBeNull()
  })

  it('skips the request entirely for an oversized buffer', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1)
    const out = await transcribeAudio({ endpoint: TEST_ENDPOINT, audioBuffer: oversized })
    expect(out).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the resolved model in the form body', async () => {
    let capturedForm: FormData | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: RequestInit) => {
        capturedForm = opts.body as FormData
        return { ok: true, status: 200, json: async () => ({ text: 'ok' }) }
      }),
    )
    await transcribeAudio({
      endpoint: { ...TEST_ENDPOINT, model: 'openai/gpt-4o-transcribe' },
      audioBuffer: Buffer.from('x'),
    })
    expect(capturedForm!.get('model')).toBe('openai/gpt-4o-transcribe')
    expect(capturedForm!.get('file')).toBeInstanceOf(Blob)
  })
})
