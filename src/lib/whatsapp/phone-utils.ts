/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Looser shape check than `isValidE164` — "could this be a phone
 * number at all" (digits only, optional leading '+', 5-15 chars),
 * rather than "is this specifically valid." Used to tell a real Meta
 * phone-number identifier apart from a WhatsApp-usernames BSUID (e.g.
 * "PE.1128521366369305" — letters and a dot, never matches this),
 * regardless of which digits happen to be embedded in the BSUID.
 * Shared by the inbound webhook's contact resolution and the contacts
 * UI (to badge a non-phone `phone` value instead of rendering it as
 * one) — see CLAUDE.md's "WhatsApp contact identity" section.
 */
export function looksLikePhoneNumber(value: string): boolean {
  return /^\+?\d{5,15}$/.test(value)
}

/**
 * What to put in an outbound Meta send body: either `to` (a real
 * phone number) or `recipient` (a WhatsApp-usernames BSUID, e.g.
 * "PE.1128521366369305"). Mutually exclusive on the wire per Meta's
 * own rule — at least one required; if both are present `to` wins; omit
 * `to` entirely when sending via `recipient`. See CLAUDE.md's
 * "WhatsApp contact identity" section.
 */
export type RecipientTarget =
  | { type: 'phone'; value: string }
  | { type: 'user_id'; value: string }

export interface RecipientResolvable {
  phone: string | null
  wa_user_id?: string | null
}

/**
 * Decide how to address a contact for an outbound Meta send.
 *
 * `contacts.phone` is NOT NULL, so a hidden-number contact has a BSUID
 * string parked there as a placeholder (fails `looksLikePhoneNumber` —
 * letters + a dot never match). Real phones route via `to`; anything
 * that isn't phone-shaped, or is phone-shaped but fails E.164, falls
 * back to `wa_user_id` when we have one. Throws when neither works —
 * callers translate that into their own error shape.
 */
export function resolveRecipientTarget(contact: RecipientResolvable): RecipientTarget {
  if (contact.phone && looksLikePhoneNumber(contact.phone)) {
    const sanitized = sanitizePhoneForMeta(contact.phone)
    if (isValidE164(sanitized)) {
      return { type: 'phone', value: sanitized }
    }
  }
  if (contact.wa_user_id) {
    return { type: 'user_id', value: contact.wa_user_id }
  }
  throw new Error(
    contact.phone && looksLikePhoneNumber(contact.phone)
      ? 'Invalid phone number format'
      : 'Contact has no phone number or WhatsApp user id on file'
  )
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}
