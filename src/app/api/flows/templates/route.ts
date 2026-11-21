import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getVerifiedUserId } from '@/lib/auth/verified-user'
import { listFlowTemplates } from '@/lib/flows/templates'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * GET /api/flows/templates
 *
 * Returns the static template gallery (slug + name + description +
 * icon hint + node_count) so the New-flow dialog can render cards
 * without bundling the full template payloads client-side. Bodies
 * are fetched only on actual clone via POST /api/flows.
 *
 * Available to any signed-in user. Flows is in soft-GA.
 */
export async function GET() {
  const supabase = await createClient()
  // Verified locally from the JWT (no /auth/v1/user round trip) — see
  // src/lib/auth/verified-user.ts.
  const verifiedId = await getVerifiedUserId(supabase)
  const user = verifiedId ? { id: verifiedId } : null
  if (!user) {
    return NextResponse.json({ error: t('common.unauthorized') }, { status: 401 })
  }
  // Shallow shape so the client gallery doesn't have to know about
  // the full node tree.
  const templates = listFlowTemplates().map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    icon: t.icon,
    trigger_type: t.trigger_type,
    node_count: t.nodes.length,
  }))
  return NextResponse.json({ templates })
}
