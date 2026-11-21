import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  buildCustomerContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    // When set, every conversation read AFTER the first returns this —
    // simulates a human taking the thread over mid-generation.
    convAfterFirstRead: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    updates: [] as { payload: Record<string, unknown>; isNull: string[] }[],
    rpcCalls: [] as { name: string; args: unknown }[],
    // Rows written to `ai_reply_events` — one per dispatch that got past
    // the account-level gate.
    events: [] as Record<string, unknown>[],
    latestInbound: [] as { message_id: string }[],
  },
}))

vi.mock('./config', () => ({
  loadAiConfig: h.loadAiConfig,
  deriveEmbeddingsEndpoint: () => null,
}))
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
  buildCustomerContext: h.buildCustomerContext,
}))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'ai_reply_events') {
        return {
          insert: (row: Record<string, unknown>) => {
            h.state.events.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'messages') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.latestInbound, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => {
              const data = h.state.conv
              if (h.state.convAfterFirstRead) {
                h.state.conv = h.state.convAfterFirstRead
                h.state.convAfterFirstRead = null
              }
              return Promise.resolve({ data, error: null })
            },
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = { ...h.state.updatePayload, ...payload }
          const record = { payload, isNull: [] as string[] }
          h.state.updates.push(record)
          const result = Promise.resolve({ error: null })
          const filter = Object.assign(result, {
            is: (column: string) => {
              record.isNull.push(column)
              return result
            },
          })
          return { eq: () => filter }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundWamid: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    baseUrl: null,
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.convAfterFirstRead = null
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.updates = []
  h.state.rpcCalls = []
  h.state.events = []
  h.state.latestInbound = [{ message_id: 'wamid.inbound-1' }]
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.buildCustomerContext.mockResolvedValue({
    name: null,
    phone: null,
    isReturningCustomer: false,
  })
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('tells the model not to ask for a name/number already on file', async () => {
    h.buildCustomerContext.mockResolvedValue({
      name: 'Thalía',
      phone: '+51912147223',
      isReturningCustomer: true,
    })
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('name: Thalía')
    expect(systemPrompt).toContain('phone number: +51912147223')
    expect(systemPrompt).toContain('returning customer')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the slot claim is refused after a human takeover', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('leaves the reply to the newer run when another inbound arrived', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-2' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('replies when the triggering inbound is still the latest', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundWamid: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('assigns the handoff agent only while the thread is still unassigned', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    const pause = h.state.updates.find((u) => 'ai_autoreply_disabled' in u.payload)
    const assign = h.state.updates.find((u) => 'assigned_agent_id' in u.payload)
    expect(pause?.payload).not.toHaveProperty('assigned_agent_id')
    expect(pause?.isNull).toEqual([])
    expect(assign?.payload).toEqual({ assigned_agent_id: 'agent-7' })
    expect(assign?.isNull).toEqual(['assigned_agent_id'])
  })

  it('sends a paired farewell message before going quiet, claiming a slot for it', async () => {
    h.generateReply.mockResolvedValue({
      text: 'A team member will take it from here shortly.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: 'A team member will take it from here shortly.',
      }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('still hands off even when the farewell message loses the slot-claim race', async () => {
    h.state.claim = false
    h.generateReply.mockResolvedValue({
      text: 'A team member will take it from here shortly.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('still hands off even when sending the farewell message throws', async () => {
    h.engineSendText.mockRejectedValue(new Error('WhatsApp API down'))
    h.generateReply.mockResolvedValue({
      text: 'A team member will take it from here shortly.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.events).toHaveLength(1)
    expect(h.state.events[0]).toMatchObject({
      outcome: 'handoff',
      reason: 'handoff',
    })
    expect(h.state.events[0].detail).toContain('WhatsApp API down')
  })
})

describe('dispatchInboundToAiReply — ai_reply_events audit trail', () => {
  const event = () => {
    expect(h.state.events).toHaveLength(1)
    return h.state.events[0]
  }

  it('records a replied/sent event carrying the inbound message id', async () => {
    await dispatchInboundToAiReply({ ...ARGS, inboundMessageRowId: 'msg-42' })
    expect(event()).toMatchObject({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      message_id: 'msg-42',
      outcome: 'replied',
      reason: 'sent',
      detail: null,
    })
  })

  it('writes nothing when the account has no auto-reply at all', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.events).toHaveLength(0)

    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.events).toHaveLength(0)
  })

  it('records cap_reached with the count vs cap', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({
      outcome: 'skipped',
      reason: 'cap_reached',
      detail: '3/3',
    })
  })

  it('records human_assigned / paused / automation_active / no_context skips', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({ outcome: 'skipped', reason: 'human_assigned' })

    h.state.events = []
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({ outcome: 'skipped', reason: 'paused' })

    h.state.events = []
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({
      outcome: 'skipped',
      reason: 'automation_active',
    })

    h.state.events = []
    h.state.autoResponders = []
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({ outcome: 'skipped', reason: 'no_context' })
  })

  it('records cap_race when the atomic claim loses', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({ outcome: 'skipped', reason: 'cap_race' })
  })

  it('records taken_over, not cap_race, when a human took the thread mid-generation', async () => {
    // Migration 053: the claim also refuses once the conversation is
    // assigned or paused. The early read saw it free; the re-read after
    // the refused claim sees the agent.
    h.state.claim = false
    h.state.convAfterFirstRead = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toMatchObject({
      outcome: 'skipped',
      reason: 'taken_over',
    })
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(event()).toMatchObject({ outcome: 'skipped', reason: 'taken_over' })
  })

  it('records superseded and sends nothing when the customer wrote again', async () => {
    h.state.latestInbound = [{ message_id: 'wamid.inbound-2' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    // No slot is consumed for a reply that never goes out.
    expect(h.state.rpcCalls).toEqual([])
    expect(event()).toMatchObject({ outcome: 'skipped', reason: 'superseded' })
  })

  it('keeps the row id and the wamid apart', async () => {
    // The UUID goes to the audit row; the wamid drives the typing
    // indicator and the superseded check. Swapping them would make every
    // attempt look superseded.
    await dispatchInboundToAiReply({
      ...ARGS,
      inboundMessageRowId: '11111111-1111-4111-8111-111111111111',
    })
    expect(h.sendTypingIndicator).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'wamid.inbound-1' }),
    )
    expect(event()).toMatchObject({
      message_id: '11111111-1111-4111-8111-111111111111',
      outcome: 'replied',
    })
  })

  it('records a provider failure with the AiError code and message', async () => {
    const { AiError } = await import('./types')
    h.generateReply.mockRejectedValue(
      new AiError('OpenRouter rate limit reached: insufficient credits', {
        code: 'rate_limited',
        status: 502,
      }),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(event()).toMatchObject({
      outcome: 'failed',
      reason: 'provider_error',
      detail:
        'rate_limited: OpenRouter rate limit reached: insufficient credits',
    })
  })

  it('records a send failure after the model answered', async () => {
    h.engineSendText.mockRejectedValue(
      new Error('contact phone invalid: Invalid phone number format'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({ outcome: 'failed', reason: 'send_error' })
    expect(event().detail).toContain('Invalid phone number format')
  })

  it('records a config failure when the stored key cannot be decrypted', async () => {
    h.loadAiConfig.mockRejectedValue(new Error('Unsupported state or unable to authenticate data'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(event()).toMatchObject({ outcome: 'failed', reason: 'config_error' })
  })

  it('maps an unexpected throw to unknown_error, never rejects, and returns the attempt', async () => {
    h.buildCustomerContext.mockRejectedValue(new Error('db exploded'))
    // The attempt is returned (not just logged) so the webhook can pick
    // the right push notification for the message — see src/lib/push/inbound.ts.
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toMatchObject({
      outcome: 'failed',
      reason: 'unknown_error',
      detail: 'db exploded',
    })
    expect(event()).toMatchObject({
      outcome: 'failed',
      reason: 'unknown_error',
      detail: 'db exploded',
    })
  })
})
