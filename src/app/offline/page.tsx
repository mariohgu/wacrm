"use client";

import { useTranslations } from "next-intl";
import { WifiOff } from "lucide-react";
import { DEFAULT_LANDING_PATH } from "@/lib/navigation";

// The page the service worker (public/sw.js) serves in place of a
// navigation that failed because the network is down. It precaches
// this route at install time, so keep it self-sufficient: no data
// fetching, no auth, and nothing that must load from the network to
// be useful — a Next page still references its JS chunks, but the
// server-rendered HTML carries the full text, and the only control is
// a plain link (a new navigation → the worker tries the network again,
// and lands back here if it is still down). Sits outside the
// (dashboard) group on purpose so it renders without the auth-gated
// shell.
export default function OfflinePage() {
  const t = useTranslations("Offline");

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <WifiOff className="h-7 w-7 text-primary" />
        </div>
        <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("body")}</p>
        <a
          href={DEFAULT_LANDING_PATH}
          className="mt-2 inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {t("retry")}
        </a>
      </div>
    </div>
  );
}
