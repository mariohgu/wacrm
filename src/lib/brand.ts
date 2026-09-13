/**
 * The product name shown to users: browser tab titles, the installed
 * app's name and home-screen label, the iOS web-app title, and the
 * sidebar logo.
 *
 * Deliberately a constant rather than an i18n key — a brand name is
 * the same in every locale, and having it in `messages/*.json` invites
 * three copies drifting apart.
 *
 * This is the *display* name only. Several machine-facing identifiers
 * still spell the upstream template's name and must NOT be renamed
 * along with it:
 *   - `API_KEY_PREFIX` (`wacrm_live_`, src/lib/api-keys/keys.ts) —
 *     existing keys are stored hashed, so changing the prefix would
 *     invalidate every key already issued.
 *   - The `X-Wacrm-Signature` webhook header — a contract with
 *     whatever external service already verifies it.
 *   - The `wacrm.*` / `wacrm:*` localStorage keys (theme, mode, inbox
 *     panel) — renaming them silently resets each user's saved
 *     preferences.
 *   - `package.json` name and the repo README, which identify the
 *     fork, not the running app.
 */
export const APP_NAME = "MlennyChatBot";
