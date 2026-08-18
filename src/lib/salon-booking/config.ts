import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

interface SalonBookingConfigRow {
  base_url: string
  api_token: string
  default_cliente_id: string
  default_estado_id: string
  default_servicio_id: string
  default_servicio_precio: number
  default_servicio_duracion_min: number
  default_staff_id: string | null
  is_active: boolean
}

/** Account setup for the external salon booking API, decrypted and
 *  ready to use. Produced by `loadSalonBookingConfig`. */
export interface SalonBookingConfig {
  baseUrl: string
  apiToken: string
  defaultClienteId: string
  defaultEstadoId: string
  defaultServicioId: string
  defaultServicioPrecio: number
  defaultServicioDuracionMin: number
  defaultStaffId: string | null
}

const CONFIG_COLUMNS =
  'base_url, api_token, default_cliente_id, default_estado_id, default_servicio_id, default_servicio_precio, default_servicio_duracion_min, default_staff_id, is_active'

/**
 * Load and decrypt the account's salon booking config for *use* by the
 * `create_salon_appointment` Flow node. Returns `null` when there's no
 * row or the master switch (`is_active`) is off — both mean "booking is
 * not available," which the node treats identically (routes to its
 * `error_next_node_key`). Throws only if the stored token can't be
 * decrypted (mismatched `ENCRYPTION_KEY`), so that distinct failure
 * surfaces rather than looking like "not configured."
 */
export async function loadSalonBookingConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<SalonBookingConfig | null> {
  const { data, error } = await db
    .from('salon_booking_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as SalonBookingConfigRow
  if (!row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing token as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_token) return null

  return {
    baseUrl: row.base_url,
    apiToken: decrypt(row.api_token),
    defaultClienteId: row.default_cliente_id,
    defaultEstadoId: row.default_estado_id,
    defaultServicioId: row.default_servicio_id,
    defaultServicioPrecio: row.default_servicio_precio,
    defaultServicioDuracionMin: row.default_servicio_duracion_min,
    defaultStaffId: row.default_staff_id,
  }
}
