/**
 * Where the app lands when it has no more specific destination:
 * opening the installed PWA, hitting `/`, finishing a sign-in, or
 * accepting an invite.
 *
 * The Inbox rather than the Dashboard — on a phone the app is opened
 * to answer a customer, not to read charts, and the manifest's
 * `start_url` points here too so the installed app and the browser
 * agree. Every role (owner → viewer) can open the Inbox, so this is a
 * safe destination for any signed-in user; if that ever stops being
 * true, this constant becomes a function of the role instead.
 *
 * Kept in its own module with no imports so `src/middleware.ts` can
 * pull it into the Edge runtime.
 */
export const DEFAULT_LANDING_PATH = "/inbox";
