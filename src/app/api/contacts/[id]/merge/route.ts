import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/contacts/admin-client';

async function readLoserId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as {
    loser_id?: unknown;
  } | null;
  return typeof body?.loser_id === 'string' && body.loser_id.trim()
    ? body.loser_id.trim()
    : null;
}

/**
 * Collapse a duplicate contact into the one being viewed (see
 * migration 040's `merge_contacts`, and CLAUDE.md's "WhatsApp contact
 * identity" section for why this exists — a WhatsApp-usernames
 * customer can end up with a second, BSUID-keyed row before staff
 * links the username onto her real one).
 *
 * `merge_contacts` is SECURITY DEFINER and its EXECUTE grant is
 * service_role-only (it bypasses RLS and deletes a row), so this
 * route is the only thing allowed to call it — and it must do the
 * authorization the DB function trusts it to have already done:
 * admin role, and both contacts belonging to the caller's own account.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id: survivorId } = await params;
    const loserId = await readLoserId(request);

    if (!loserId) {
      return NextResponse.json({ error: 'loser_id required' }, { status: 400 });
    }
    if (loserId === survivorId) {
      return NextResponse.json(
        { error: 'Cannot merge a contact with itself' },
        { status: 400 },
      );
    }

    const { data: contacts, error: fetchError } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('account_id', ctx.accountId)
      .in('id', [survivorId, loserId]);

    if (fetchError) {
      console.error('[contacts/merge] fetch error:', fetchError);
      return NextResponse.json({ error: 'Could not verify contacts' }, { status: 500 });
    }
    if ((contacts ?? []).length !== 2) {
      return NextResponse.json(
        { error: 'Both contacts must exist in your account' },
        { status: 404 },
      );
    }

    const { error: mergeError } = await supabaseAdmin().rpc('merge_contacts', {
      p_survivor_id: survivorId,
      p_loser_id: loserId,
    });

    if (mergeError) {
      console.error('[contacts/merge] merge_contacts RPC error:', mergeError);
      return NextResponse.json({ error: 'Merge failed' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
