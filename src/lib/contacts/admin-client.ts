import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for contact-management operations
// that call SECURITY DEFINER RPCs restricted to service_role (e.g.
// `merge_contacts`, migration 040). Mirrors src/lib/ai/admin-client.ts
// and its siblings — the RLS-scoped SSR client from `requireRole()`
// cannot call a function granted only to service_role, so callers must
// authorize with `requireRole()` first and only then reach for this.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
