/**
 * Notification copy for server-side push senders.
 *
 * Pushes are composed in route handlers and inside the WhatsApp
 * webhook's `after()` block, where next-intl's request-scoped
 * `getTranslations` is not something to lean on. The app has a single
 * build-time locale (`NEXT_PUBLIC_APP_LOCALE`, see src/i18n/request.ts),
 * so this loads the same `messages/<locale>.json` the UI uses — the
 * `Push` namespace — with the same whole-file fallback to English, and
 * a minimal `{name}` interpolation. Keys live in messages/*.json so the
 * locale-parity test covers them like every other string.
 */

export type PushCopy = Record<string, string>

let cached: Promise<PushCopy> | null = null

export function loadPushCopy(): Promise<PushCopy> {
  if (!cached) {
    cached = (async () => {
      const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en'
      let messages: { Push?: PushCopy }
      try {
        messages = (await import(`../../../messages/${locale}.json`)).default
      } catch {
        messages = (await import('../../../messages/en.json')).default
      }
      return messages.Push ?? {}
    })()
  }
  return cached
}

/** `fill("Hi {name}", { name: "Ana" })` → `"Hi Ana"`. Unknown keys are left as-is. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  )
}

/** Trim a message body for a notification line. */
export function preview(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}
