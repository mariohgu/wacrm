import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { testConnection } from '@/lib/salon-booking/client'
import type { SalonBookingConfig } from '@/lib/salon-booking/config'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/salon-booking/config
 *
 * Admin-only read (unlike ai_configs' member-read) — this holds a
 * third-party Bearer token, credential-class data, not "is this
 * feature on" status every viewer needs. The encrypted token is NEVER
 * returned — only a `has_token` flag; the settings form shows a
 * masked placeholder.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data, error } = await supabase
      .from('salon_booking_configs')
      .select(
        'base_url, default_cliente_id, default_estado_id, default_servicio_id, default_servicio_precio, default_servicio_duracion_min, default_staff_id, is_active, api_token',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[salon-booking/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load salon booking configuration' },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })
    const { api_token, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_token: !!api_token,
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/salon-booking/config  (admin+)
 *
 * Upsert the account's salon booking config. Validates reachability +
 * the token with the salon API before persisting (mirrors the
 * WhatsApp/AI config pattern of verifying before save), then stores
 * the token AES-256-GCM-encrypted. When `api_token` is omitted the
 * existing stored token is reused (the form sends it only when the
 * admin re-enters it).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`salon-booking-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : ''
    if (!baseUrl) return bad('base_url is required')
    if (!/^https?:\/\//i.test(baseUrl)) return bad('base_url must start with http:// or https://')

    const defaultClienteId =
      typeof body.default_cliente_id === 'string' ? body.default_cliente_id.trim() : ''
    if (!defaultClienteId) return bad('default_cliente_id is required')

    const defaultEstadoId =
      typeof body.default_estado_id === 'string' ? body.default_estado_id.trim() : ''
    if (!defaultEstadoId) return bad('default_estado_id is required')

    const defaultServicioId =
      typeof body.default_servicio_id === 'string' ? body.default_servicio_id.trim() : ''
    if (!defaultServicioId) return bad('default_servicio_id is required')

    const defaultServicioPrecio = Number(body.default_servicio_precio)
    if (!Number.isFinite(defaultServicioPrecio) || defaultServicioPrecio < 0) {
      return bad('default_servicio_precio must be a non-negative number')
    }

    let defaultServicioDuracionMin = Number(body.default_servicio_duracion_min)
    if (!Number.isFinite(defaultServicioDuracionMin) || defaultServicioDuracionMin <= 0) {
      defaultServicioDuracionMin = 30
    }

    const rawStaffId =
      typeof body.default_staff_id === 'string' ? body.default_staff_id.trim() : ''
    const defaultStaffId = rawStaffId || null

    const isActive = body.is_active === true

    const rawToken = typeof body.api_token === 'string' ? body.api_token.trim() : ''

    // Reuse the stored token when the form didn't send a fresh one.
    const { data: existing } = await supabase
      .from('salon_booking_configs')
      .select('id, api_token')
      .eq('account_id', accountId)
      .maybeSingle()

    let tokenPlain: string
    if (rawToken) {
      tokenPlain = rawToken
    } else if (existing?.api_token) {
      try {
        tokenPlain = decrypt(existing.api_token)
      } catch {
        return bad('Stored token could not be decrypted — re-enter it.')
      }
    } else {
      return bad('api_token is required')
    }

    // Only spend a round-trip to the salon API when something that
    // affects reachability actually changed — same discipline as the
    // AI config's credentialsChanged check.
    const credentialsChanged = !existing || rawToken !== ''
    if (credentialsChanged) {
      const candidate: SalonBookingConfig = {
        baseUrl,
        apiToken: tokenPlain,
        defaultClienteId,
        defaultEstadoId,
        defaultServicioId,
        defaultServicioPrecio,
        defaultServicioDuracionMin,
        defaultStaffId,
      }
      try {
        await testConnection(candidate)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not reach the salon API.'
        return bad(message)
      }
    }

    const encryptedToken = rawToken ? encrypt(rawToken) : undefined
    const shared: Record<string, unknown> = {
      base_url: baseUrl,
      default_cliente_id: defaultClienteId,
      default_estado_id: defaultEstadoId,
      default_servicio_id: defaultServicioId,
      default_servicio_precio: defaultServicioPrecio,
      default_servicio_duracion_min: defaultServicioDuracionMin,
      default_staff_id: defaultStaffId,
      is_active: isActive,
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('salon_booking_configs')
        .update(encryptedToken ? { ...shared, api_token: encryptedToken } : shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[salon-booking/config POST] update error:', upErr)
        return NextResponse.json(
          { error: 'Failed to save salon booking configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error: insErr } = await supabase.from('salon_booking_configs').insert({
        account_id: accountId,
        created_by: userId,
        api_token: encryptedToken, // guaranteed non-null: rawToken required when no existing row
        ...shared,
      })
      if (insErr) {
        console.error('[salon-booking/config POST] insert error:', insErr)
        return NextResponse.json(
          { error: 'Failed to save salon booking configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/salon-booking/config  (admin+)
 *
 * Removes the account's config (turns booking off and forgets the
 * token). Also used to recover from a corrupted encrypted token.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('salon_booking_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[salon-booking/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete salon booking configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
