import { ImageResponse } from "next/og";

// The 32px browser-tab favicon. Same mark as the installed-app icons
// in `public/icons/` (see scripts/generate-icons.mjs): a violet→fuchsia
// gradient squircle with a white speech bubble that doubles as a bot
// face. Next renders this at build time and auto-injects
// <link rel="icon"> into <head>.
//
// Two deliberate differences from the big icons, both for legibility
// at 32px: the gradient is a CSS background on the wrapper div rather
// than an SVG <linearGradient> (Satori, which rasterises this, handles
// CSS gradients reliably and nested <defs> less so), and the bot's
// antenna is dropped — at this size its stem renders as a 1px speck.
// The face is scaled up to use the space the antenna freed.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** Face details on the white bubble — matches INK in the icon script. */
const INK = "#6d28d9";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundImage:
            "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 50%, #c026d3 100%)",
          borderRadius: 7,
        }}
      >
        <svg width="26" height="26" viewBox="0 0 512 512" fill="none">
          <rect
            x="92"
            y="120"
            width="328"
            height="240"
            rx="72"
            fill="#ffffff"
          />
          <path d="M164 300 L164 452 L276 348 Z" fill="#ffffff" />
          <circle cx="196" cy="216" r="32" fill={INK} />
          <circle cx="316" cy="216" r="32" fill={INK} />
          <path
            d="M196 280 Q256 320 316 280"
            stroke={INK}
            strokeWidth="24"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
