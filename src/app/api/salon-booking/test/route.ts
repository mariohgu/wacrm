import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { testConnection } from '@/lib/salon-booking/client'
import type { SalonBookingConfig } from '@/lib/salon-booking/config'

/**
 * POST /api/salon-booking/test  (admin+)
 *
 * "Test connection" button: validate a candidate base_url/token against
 * the salon API WITHOUT saving and WITHOUT creating an appointment.
 * When `api_token` is omitted the stored token is used, so an admin
 * can re-test an existing config (e.g. after changing the base URL).
 * Returns `{ ok: true }` on success, 400 with the API's message on
 * failure.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`salon-booking-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : ''
    if (!baseUrl) {
      return NextResponse.json({ error: 'base_url is required' }, { status: 400 })
    }

    const rawToken = typeof body.api_token === 'string' ? body.api_token.trim() : ''
    let tokenPlain = rawToken
    if (!tokenPlain) {
      const { data: existing } = await supabase
        .from('salon_booking_configs')
        .select('api_token')
        .eq('account_id', accountId)
        .maybeSingle()
      if (!existing?.api_token) {
        return NextResponse.json(
          { error: 'Enter a token to test.' },
          { status: 400 },
        )
      }
      try {
        tokenPlain = decrypt(existing.api_token)
      } catch {
        return NextResponse.json(
          { error: 'Stored token could not be decrypted — re-enter it.' },
          { status: 400 },
        )
      }
    }

    // The default-id fields don't matter for a reachability + auth
    // check — `testConnection` only ever GETs the citas endpoint.
    const candidate: SalonBookingConfig = {
      baseUrl,
      apiToken: tokenPlain,
      defaultClienteId: '',
      defaultEstadoId: '',
      defaultServicioId: '',
      defaultServicioPrecio: 0,
      defaultServicioDuracionMin: 30,
      defaultStaffId: null,
    }

    try {
      await testConnection(candidate)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not reach the salon API.'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
