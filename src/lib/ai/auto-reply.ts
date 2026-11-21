import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig, deriveEmbeddingsEndpoint } from './config'
import { buildConversationContext, buildCustomerContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import {
  describeError,
  logAiReplyEvent,
  type AiReplyOutcome,
  type AiReplyReason,
} from './reply-events'
import type { AiConfig } from './types'
import {
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** The inbound `messages.id` (internal UUID) that triggered this
   *  attempt — recorded on the `ai_reply_events` row so the inbox can
   *  point at the exact customer message the bot did (or didn't) answer.
   *  Optional so older callers/tests still compile. */
  inboundMessageRowId?: string | null
  /** Meta's wamid of that same customer message. When set, a typing
   *  indicator (which also marks it read) is shown while the reply is
   *  generated, and a reply is dropped if a newer customer message has
   *  arrived in the meantime.
   *
   *  NOT interchangeable with `inboundMessageRowId`: both are strings,
   *  so the compiler cannot catch a swap. A UUID passed here makes
   *  every attempt look superseded (the bot never replies); a wamid
   *  passed there breaks the `ai_reply_events.message_id` foreign key. */
  inboundWamid?: string | null
}

/** What one auto-reply attempt ended up doing — persisted to
 *  `ai_reply_events` by the dispatcher. */
export interface AutoReplyAttempt {
  outcome: AiReplyOutcome
  reason: AiReplyReason
  detail?: string | null
}

const attempt = (
  outcome: AiReplyOutcome,
  reason: AiReplyReason,
  detail?: string | null,
): AutoReplyAttempt => ({ outcome, reason, detail: detail ?? null })

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → no reply):
 *   - AI off / auto-reply disabled for the account (not logged — the
 *     account isn't using the bot at all)
 *   - an active message-level automation exists (it owns auto-responses)
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *   - the account-wide burst limit is hit
 *   - a newer customer message arrived while the reply was generated
 *   - a human took the thread over while the reply was generated
 *
 * Every attempt past the account-level gate — replied, handed off,
 * skipped for one of the reasons above, or failed — writes one row to
 * `ai_reply_events` (see `reply-events.ts`), which is what the inbox
 * banner and Agents → Usage read to explain a silent bot.
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<AutoReplyAttempt | null> {
  let db: SupabaseClient
  try {
    db = supabaseAdmin()
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
    return null
  }

  let result: AutoReplyAttempt | null
  try {
    result = await runAutoReply(db, args)
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
    result = attempt('failed', 'unknown_error', describeError(err))
  }

  if (!result) return null // account has no auto-reply — nothing to explain
  if (result.outcome === 'failed') {
    console.error(
      `[ai auto-reply] ${result.reason} on conversation ${args.conversationId}: ${result.detail ?? ''}`,
    )
  }
  await logAiReplyEvent(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    messageId: args.inboundMessageRowId ?? null,
    outcome: result.outcome,
    reason: result.reason,
    detail: result.detail ?? null,
  })
  // Returned (not just logged) so the webhook can pick the right push:
  // quiet when the bot answered, "needs attention" when it handed off,
  // capped or failed. See src/lib/push/inbound.ts.
  return result
}

/**
 * The attempt itself. Returns `null` when the account has no auto-reply
 * configured (nothing to log), otherwise the outcome. Throws only on
 * truly unexpected errors — the dispatcher maps those to
 * `failed/unknown_error`.
 */
async function runAutoReply(
  db: SupabaseClient,
  args: DispatchArgs,
): Promise<AutoReplyAttempt | null> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundWamid,
  } = args

  let config: AiConfig | null
  try {
    config = await loadAiConfig(db, accountId)
  } catch (err) {
    // `loadAiConfig` throws only when the stored key can't be decrypted
    // (ENCRYPTION_KEY mismatch) or the read itself fails — a deploy-class
    // problem worth surfacing, not "AI not configured".
    return attempt('failed', 'config_error', describeError(err))
  }
  if (!config || !config.autoReplyEnabled) return null

  // Deterministic, user-configured responders win over the LLM — the
  // caller already excludes messages a Flow consumed. Message-level
  // automations (`new_message_received` / `keyword_match`) are
  // dispatched independently for this same inbound and may send their
  // own reply, so if the account has any active one we stand down to
  // avoid double-texting the customer. (Relationship triggers like
  // `first_inbound_message` don't count — they're not per-message
  // auto-responders.)
  const { data: autoResponders } = await db
    .from('automations')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .in('trigger_type', ['new_message_received', 'keyword_match'])
    .limit(1)
  if (autoResponders && autoResponders.length > 0) {
    return attempt('skipped', 'automation_active')
  }

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
    .eq('id', conversationId)
    .maybeSingle()
  if (convErr || !conv) {
    return attempt(
      'skipped',
      'conversation_missing',
      convErr ? describeError(convErr) : null,
    )
  }
  if (conv.assigned_agent_id) return attempt('skipped', 'human_assigned')
  if (conv.ai_autoreply_disabled) return attempt('skipped', 'paused')
  // Cheap early-out; the authoritative cap check is the atomic claim
  // below (this read can race a concurrent inbound).
  if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
    return attempt(
      'skipped',
      'cap_reached',
      `${conv.ai_reply_count}/${config.autoReplyMaxPerConversation}`,
    )
  }

  const messages = await buildConversationContext(db, conversationId)
  if (messages.length === 0) return attempt('skipped', 'no_context')

  const customer = await buildCustomerContext(db, conversationId, contactId)

  // Account-wide throttle on the shared BYO key. The per-conversation
  // cap bounds one thread; this bounds a burst across many threads (a
  // marketing blast landing 200 replies at once) so we never run the
  // owner's key past the provider's rate limit. Over the limit → skip
  // the auto-reply; the inbound still sits in the inbox for a human.
  const acctLimit = checkRateLimit(
    `ai-autoreply:${accountId}`,
    RATE_LIMITS.aiAutoReplyAccount,
  )
  if (!acctLimit.success) {
    console.warn(
      `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
    )
    return attempt('skipped', 'account_rate_limited')
  }

  // Every gate has passed — we're committed to attempting a reply, so
  // show the customer "typing…" (and mark their message read) while the
  // retrieval + LLM round trips run. Meta clears the indicator after
  // 25 s or when our reply lands, whichever is first, so there's
  // nothing to undo on the handoff / no-text path. Strictly
  // best-effort: a failed indicator must never cost us the reply.
  if (inboundWamid) {
    await showTypingIndicator(db, accountId, inboundWamid)
  }

  // Ground the reply in the account's knowledge base (best-effort).
  const knowledge = await retrieveKnowledge(
    db,
    accountId,
    deriveEmbeddingsEndpoint(config),
    latestUserMessage(messages),
  )

  const systemPrompt = buildSystemPrompt({
    userPrompt: config.systemPrompt,
    mode: 'auto_reply',
    knowledge,
    customer,
  })

  let generated: Awaited<ReturnType<typeof generateReply>>
  try {
    generated = await generateReply({ config, systemPrompt, messages })
  } catch (err) {
    // The provider said no (bad key, rate limit, insufficient credits,
    // timeout, empty response…) — this is the "is it OpenRouter or is it
    // us?" answer. `describeError` keeps the AiError code as a prefix.
    return attempt('failed', 'provider_error', describeError(err))
  }
  const { text, handoff, usage } = generated

  // Record token spend on the account's BYO key. Fire-and-forget so it
  // never adds latency to the customer-facing send: `logAiUsage`
  // swallows its own errors, so the floating promise can't reject.
  // Logged regardless of handoff — the provider call happened either
  // way.
  void logAiUsage(db, {
    accountId,
    conversationId,
    mode: 'auto_reply',
    provider: config.provider,
    model: config.model,
    usage,
  })

  if (handoff || !text) {
    // The model can't (or shouldn't) answer — stop auto-replying on
    // this thread and hand it to a human. We (a) pause the bot here
    // (sticky until re-enabled), (b) route the conversation to the
    // configured handoff agent — null leaves it in the shared queue —
    // and (c) leave a short internal note so whoever picks it up has
    // context. Assigning fires the `on_conversation_assigned` trigger,
    // which notifies the agent.

    // The model can pair the sentinel with a customer-facing message
    // (e.g. a graceful "a human will take it from here" line) — send it
    // before going quiet, gated by the same atomic reply-slot claim as
    // a normal reply so it still counts against the per-conversation
    // cap and can't race a concurrent inbound. Best-effort: a send
    // failure must not skip the handoff bookkeeping below, or the
    // conversation is silently stuck in bot mode with no human queued.
    let farewell: 'sent' | 'skipped' | 'failed' = 'skipped'
    let farewellError: string | null = null
    if (text) {
      try {
        const { data: claimed } = await db.rpc('claim_ai_reply_slot', {
          conversation_id: conversationId,
          max_replies: config.autoReplyMaxPerConversation,
        })
        if (claimed === true) {
          await engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text,
            aiGenerated: true,
          })
          farewell = 'sent'
        }
      } catch (err) {
        console.error('[ai auto-reply] handoff message send failed:', err)
        farewell = 'failed'
        farewellError = describeError(err)
      }
    }

    const summary = buildHandoffSummary({
      messages,
      replyCount: conv.ai_reply_count ?? 0,
    })
    await db
      .from('conversations')
      .update({ ai_autoreply_disabled: true, ai_handoff_summary: summary })
      .eq('id', conversationId)
    // Only set the assignee when a target is configured AND the thread
    // isn't already owned — never stomp an existing human assignment.
    // A separate, guarded UPDATE (`assigned_agent_id IS NULL`) rather
    // than a field on the one above: the `conv` read at the top can be
    // seconds stale by now, and an agent may have picked the thread up
    // while the model was generating.
    if (config.handoffAgentId) {
      await db
        .from('conversations')
        .update({ assigned_agent_id: config.handoffAgentId })
        .eq('id', conversationId)
        .is('assigned_agent_id', null)
    }

    return attempt(
      'handoff',
      'handoff',
      farewell === 'failed'
        ? `farewell send failed: ${farewellError}`
        : farewell === 'sent'
          ? 'farewell sent'
          : 'no farewell message',
    )
  }

  // The customer wrote again while this reply was being generated: the
  // newer message has its own attempt, with the full context. Sending
  // this one too would answer a question they have already moved past.
  if (inboundWamid && (await hasNewerInbound(db, conversationId, inboundWamid))) {
    return attempt('skipped', 'superseded')
  }

  // Atomically claim a reply slot: the cap check + increment happen in
  // one UPDATE, so concurrent inbounds can never overshoot the cap. If
  // another inbound just took the last slot, `claimed` is false and we
  // skip the send. (We consume a slot slightly before the send lands —
  // fail-safe: under-reply rather than over-reply.)
  const { data: claimed, error: claimErr } = await db.rpc(
    'claim_ai_reply_slot',
    {
      conversation_id: conversationId,
      max_replies: config.autoReplyMaxPerConversation,
    },
  )
  if (claimErr) {
    // A real error here (vs. losing the cap race) is almost always a
    // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
    // service role, or the migration not applied. Logged loudly by the
    // dispatcher: a silent return makes "auto-reply never fires"
    // undiagnosable.
    return attempt('failed', 'claim_error', describeError(claimErr))
  }
  if (claimed !== true) {
    // Since migration 053 the claim also refuses when the conversation
    // was paused or assigned to a person after the early read above —
    // i.e. a human took the thread over mid-generation. That is a very
    // different story from "the cap was hit" for whoever reads the
    // banner or gets the push, so tell the two apart.
    const { data: now } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled')
      .eq('id', conversationId)
      .maybeSingle()
    if (now && (now.assigned_agent_id || now.ai_autoreply_disabled)) {
      return attempt('skipped', 'taken_over')
    }
    // Lost the per-conversation cap race (or the cap was reached between
    // the early read above and this claim).
    return attempt('skipped', 'cap_race')
  }

  try {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    // The model answered but WhatsApp didn't take it (invalid recipient,
    // Meta API error, WhatsApp not configured…). The slot is already
    // consumed — deliberate, see above.
    return attempt('failed', 'send_error', describeError(err))
  }

  return attempt('replied', 'sent')
}

/**
 * True when the most recent customer message in the conversation is not
 * the one this attempt is answering.
 */
async function hasNewerInbound(
  db: SupabaseClient,
  conversationId: string,
  inboundWamid: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('message_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return false
  return data[0].message_id !== inboundWamid
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: SupabaseClient,
  accountId: string,
  inboundWamid: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundWamid,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
