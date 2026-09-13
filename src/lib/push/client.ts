/**
 * Browser-side Web Push helpers, used by the Settings → Push
 * notifications panel. Everything here is feature-detected; nothing
 * throws for an unsupported browser — it reports a status instead.
 *
 * Platform notes the panel's states are built on:
 *   - Android Chrome/Edge/Samsung: works installed or in a tab.
 *   - iPhone/iPad: only in the app installed to the Home Screen via
 *     Safari's Share → Add to Home Screen (iOS 16.4+). In a Safari or
 *     Chrome tab `PushManager` simply doesn't exist, so iOS is checked
 *     *before* support so the user gets "install it first" rather than
 *     "not supported".
 *   - The permission prompt must come from a user gesture; the panel
 *     calls `subscribeThisDevice` from a button's onClick only.
 */

export type PushSubscribeResult =
  | 'subscribed'
  | 'denied'
  | 'unsupported'
  | 'no_worker'
  | 'not_configured'

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** Running as an installed app (home-screen icon), not in a browser tab. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    nav.standalone === true
  )
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPadOS 13+ reports itself as a Mac; the touch-point check tells it apart.
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

export function getVapidPublicKey(): string | null {
  // Inlined at build time by Next (NEXT_PUBLIC_ prefix).
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null
}

/**
 * The registration our own worker made (scope "/"). `null` in dev —
 * the worker is only registered in production builds — and on a first
 * visit before registration finished.
 */
export async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null
  try {
    return (await navigator.serviceWorker.getRegistration('/')) ?? null
  } catch {
    return null
  }
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  const registration = await getServiceWorkerRegistration()
  if (!registration) return null
  try {
    return await registration.pushManager.getSubscription()
  } catch {
    return null
  }
}

/**
 * Ask for permission (must be called from a user gesture), subscribe
 * this browser against our VAPID key, and register the subscription
 * with the server.
 */
export async function subscribeThisDevice(): Promise<PushSubscribeResult> {
  if (!isPushSupported()) return 'unsupported'
  const publicKey = getVapidPublicKey()
  if (!publicKey) return 'not_configured'
  const registration = await getServiceWorkerRegistration()
  if (!registration) return 'no_worker'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }))

  const res = await fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  })
  if (!res.ok) {
    // Don't leave a browser subscription the server doesn't know about.
    await subscription.unsubscribe().catch(() => undefined)
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `Subscription registration failed (${res.status})`)
  }
  return 'subscribed'
}

/** Unsubscribe this browser and forget it server-side. */
export async function unsubscribeThisDevice(): Promise<void> {
  const subscription = await getCurrentSubscription()
  if (!subscription) return
  const endpoint = subscription.endpoint
  await subscription.unsubscribe().catch(() => undefined)
  await fetch('/api/push/subscriptions', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined)
}

/**
 * VAPID public keys are URL-safe base64; `pushManager.subscribe` wants
 * the raw bytes. Built on an explicit ArrayBuffer so the result types
 * as `Uint8Array<ArrayBuffer>`, which is what `BufferSource` accepts.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
