import type { MetadataRoute } from "next";
import { DEFAULT_LANDING_PATH } from "@/lib/navigation";
import { DEFAULT_MODE, THEME_COLOR_BY_MODE } from "@/lib/themes";

// Web app manifest — what makes the app installable ("Add to Home
// Screen" on iOS Safari, the install prompt on Android Chrome) and
// what makes it open as a standalone app instead of a browser tab.
// Next serves this at /manifest.webmanifest and injects the <link>.
//
// The icons live in public/icons/ and are rendered from the same
// brand mark as src/app/icon.tsx (violet rounded square + chat
// glyph). The maskable variant is full-bleed with the glyph inside
// the 80% safe zone so Android's adaptive-icon masks don't clip it.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "wacrm",
    short_name: "wacrm",
    description: "Shared WhatsApp inbox, contacts, pipelines and automations.",
    // Same destination the root route and the post-sign-in redirect
    // use; the middleware still bounces signed-out users to /login.
    start_url: DEFAULT_LANDING_PATH,
    scope: "/",
    display: "standalone",
    background_color: THEME_COLOR_BY_MODE[DEFAULT_MODE],
    theme_color: THEME_COLOR_BY_MODE[DEFAULT_MODE],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
