import type { SalonBookingConfig } from './config'

// ============================================================
// Plain-fetch client for the external salon booking API (a separate
// Laravel + Sanctum system, not part of this repo). Same shape as the
// AI provider adapters (src/lib/ai/providers/*) and
// src/lib/whatsapp/meta-api.ts — no SDK, Bearer auth, timeout, typed
// error normalization.
// ============================================================

const REQUEST_TIMEOUT_MS = 10_000

export class SalonBookingError extends Error {
  readonly code: string
  constructor(message: string, code = 'salon_booking_error') {
    super(message)
    this.name = 'SalonBookingError'
    this.code = code
  }
}

export interface SalonAppointmentPayload {
  id_cliente: string
  id_staff: string | null
  id_estado_cita: string
  fecha_cita: string
  hora_inicio: string
  hora_fin: string
  origen_reserva: 'whatsapp'
  notas_cliente: string
  notas_internas: string
  requiere_confirmacion: boolean
  servicios: Array<{
    id_servicio: string
    precio_servicio: number
    duracion_minutos: number
    orden: number
    notas: string
  }>
}

interface SalonAppointmentResponse {
  data?: { id_cita?: string | number } | unknown[]
  id_cita?: string | number
}

function citasUrl(config: SalonBookingConfig, query = ''): string {
  return `${config.baseUrl.replace(/\/+$/, '')}/citas${query}`
}

/** POST a new appointment. Returns the created id when the response
 *  includes one — best-effort, not required for the booking to count. */
export async function createAppointment(
  config: SalonBookingConfig,
  payload: SalonAppointmentPayload,
): Promise<{ appointmentId: string | null }> {
  let res: Response
  try {
    res = await fetch(citasUrl(config), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await toHttpError(res)
  }

  const data = (await res.json().catch(() => null)) as SalonAppointmentResponse | null
  return { appointmentId: extractAppointmentId(data) }
}

/** Lightweight reachability + auth check for the "Test connection"
 *  settings button. Never creates an appointment. */
export async function testConnection(config: SalonBookingConfig): Promise<void> {
  let res: Response
  try {
    res = await fetch(citasUrl(config, '?per_page=1'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) {
    throw await toHttpError(res)
  }
}

function extractAppointmentId(data: SalonAppointmentResponse | null): string | null {
  if (!data) return null
  const nested =
    data.data && !Array.isArray(data.data) && typeof data.data === 'object'
      ? (data.data as { id_cita?: string | number }).id_cita
      : undefined
  const raw = nested ?? data.id_cita
  return raw === undefined || raw === null ? null : String(raw)
}

function toNetworkError(err: unknown): SalonBookingError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new SalonBookingError('The salon API took too long to respond.', 'timeout')
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new SalonBookingError(`Could not reach the salon API: ${msg}`, 'network_error')
}

/** Build a typed error from a non-2xx response, pulling detail out of
 *  either Laravel error shape the salon frontend already handles
 *  defensively: `{ errors: { field: [msg] } }` (validation) or
 *  `{ error: { message } } | { error: string } | { message }`. */
async function toHttpError(res: Response): Promise<SalonBookingError> {
  let detail = ''
  try {
    const body = (await res.json()) as {
      message?: string
      errors?: Record<string, string[]>
      error?: { message?: string } | string
    }
    if (body?.errors && typeof body.errors === 'object') {
      detail = Object.values(body.errors).flat().join('; ')
    } else if (typeof body?.error === 'string') {
      detail = body.error
    } else if (body?.error?.message) {
      detail = body.error.message
    } else if (body?.message) {
      detail = body.message
    }
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_token'
      : status === 422
        ? 'validation_error'
        : 'api_error'
  const base =
    code === 'invalid_token'
      ? 'Salon API rejected the token'
      : code === 'validation_error'
        ? 'Salon API rejected the appointment data'
        : `Salon API error (${status})`

  return new SalonBookingError(detail ? `${base}: ${detail}` : base, code)
}
