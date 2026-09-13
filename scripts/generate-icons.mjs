/**
 * Renders the app icons in `public/icons/` from one source drawing.
 *
 * Run from the repo root (it resolves `sharp` out of the local
 * node_modules, which is a devDependency of `next`):
 *
 *     node scripts/generate-icons.mjs
 *
 * Re-run this whenever the brand mark changes, and keep
 * `src/app/icon.tsx` (the 32px favicon, drawn separately because
 * Next renders it through Satori rather than sharp) looking like the
 * same mark.
 *
 * The mark: a violet→fuchsia gradient squircle with a white speech
 * bubble that doubles as a bot face (antenna, eyes, smile).
 */
import sharp from "sharp";

/** Brand gradient. Starts at the app's `--primary` violet. */
const GRADIENT_FROM = "#8b5cf6";
const GRADIENT_MID = "#7c3aed";
const GRADIENT_TO = "#c026d3";
/** Face details, on the white bubble. */
const INK = "#6d28d9";

/**
 * @param size    pixel size of the square canvas
 * @param maskable full-bleed background + glyph scaled into the inner
 *   80% safe zone, for Android adaptive icons (which crop to a
 *   platform-chosen shape). Non-maskable icons get rounded corners of
 *   their own and can use the full canvas.
 */
function svg(size, { maskable = false } = {}) {
  const radius = maskable ? 0 : Math.round(size * 0.225);
  // The glyph is drawn in a fixed 512 coordinate space and scaled by
  // the outer <svg> viewBox, so these numbers never change with size.
  const glyph = `
    <circle cx="256" cy="104" r="21" fill="#ffffff"/>
    <rect x="248" y="116" width="16" height="44" rx="8" fill="#ffffff"/>
    <rect x="116" y="152" width="280" height="206" rx="62" fill="#ffffff"/>
    <path d="M176 302 L176 436 L274 344 Z" fill="#ffffff"/>
    <circle cx="200" cy="232" r="27" fill="${INK}"/>
    <circle cx="312" cy="232" r="27" fill="${INK}"/>
    <path d="M202 288 Q256 322 310 288" stroke="${INK}" stroke-width="20"
          stroke-linecap="round" fill="none"/>
  `;
  // 0.8 scale about the canvas centre keeps every part of the mark
  // inside the maskable safe circle.
  const body = maskable
    ? `<g transform="translate(256 256) scale(0.8) translate(-256 -256)">${glyph}</g>`
    : glyph;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${GRADIENT_FROM}"/>
      <stop offset="0.5" stop-color="${GRADIENT_MID}"/>
      <stop offset="1" stop-color="${GRADIENT_TO}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${Math.round((radius / size) * 512)}" fill="url(#bg)"/>
  ${body}
</svg>`;
}

/**
 * Android status-bar badge (the small icon next to the notification
 * text). Android uses only the alpha channel, so this is white shapes
 * on transparent with the face cut out — a solid silhouette would just
 * be a blob.
 */
function badgeSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <mask id="face">
      <rect width="512" height="512" fill="black"/>
      <g transform="translate(256 256) scale(0.92) translate(-256 -256)">
        <circle cx="256" cy="104" r="21" fill="white"/>
        <rect x="248" y="116" width="16" height="44" rx="8" fill="white"/>
        <rect x="116" y="152" width="280" height="206" rx="62" fill="white"/>
        <path d="M176 302 L176 436 L274 344 Z" fill="white"/>
        <circle cx="200" cy="232" r="27" fill="black"/>
        <circle cx="312" cy="232" r="27" fill="black"/>
        <path d="M202 288 Q256 322 310 288" stroke="black" stroke-width="20" stroke-linecap="round" fill="none"/>
      </g>
    </mask>
  </defs>
  <rect width="512" height="512" fill="#ffffff" mask="url(#face)"/>
</svg>`;
}

const targets = [
  ["public/icons/badge-96.png", badgeSvg(96)],
  ["public/icons/icon-192.png", svg(192)],
  ["public/icons/icon-512.png", svg(512)],
  ["public/icons/icon-maskable-512.png", svg(512, { maskable: true })],
  // iOS draws its own rounded mask over this and does not honour
  // transparency, so it wants the square, full-bleed variant.
  ["public/icons/apple-touch-icon.png", svg(180, { maskable: true })],
];

for (const [out, source] of targets) {
  await sharp(Buffer.from(source)).png().toFile(out);
  console.log("wrote", out);
}
