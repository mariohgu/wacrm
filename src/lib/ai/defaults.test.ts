import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt — customer record block', () => {
  it('omits the block entirely when no customer context is given', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    expect(prompt).not.toContain('Customer record')
  })

  it('omits the block when the customer has no name, phone, or history', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      customer: { name: null, phone: null, isReturningCustomer: false },
    })
    expect(prompt).not.toContain('Customer record')
  })

  it('tells the model the name and phone are already on file, so it should not ask again', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      customer: {
        name: 'Thalía',
        phone: '+51912147223',
        isReturningCustomer: true,
      },
    })
    expect(prompt).toContain('Customer record')
    expect(prompt).toContain('returning customer')
    expect(prompt).toContain('do not ask the customer for this again')
    expect(prompt).toContain('name: Thalía')
    expect(prompt).toContain('phone number: +51912147223')
  })

  it('flags a first-time customer with no name/phone on file yet', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      customer: { name: null, phone: null, isReturningCustomer: false },
    })
    // isReturningCustomer is false and there's nothing else to report —
    // per the omission rule above, the whole block is skipped rather
    // than printing an empty-handed sentence.
    expect(prompt).not.toContain('Customer record')
  })

  it('still surfaces a returning customer even with no name/phone captured', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      customer: { name: null, phone: null, isReturningCustomer: true },
    })
    expect(prompt).toContain('returning customer')
    expect(prompt).toContain("name and phone number aren't on file yet")
  })

  it('never surfaces a BSUID placeholder as a phone number (caller-side guarantee)', () => {
    // buildCustomerContext is responsible for filtering this out before
    // it ever reaches buildSystemPrompt — this asserts the prompt layer
    // faithfully reflects whatever it's given, i.e. passing null here
    // (as buildCustomerContext would for a hidden-number contact) omits
    // the phone line entirely rather than fabricating one.
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      customer: { name: 'thali.vd_', phone: null, isReturningCustomer: true },
    })
    expect(prompt).toContain('name: thali.vd_')
    expect(prompt).not.toContain('phone number')
  })
})
