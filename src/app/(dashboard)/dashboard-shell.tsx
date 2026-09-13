"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { BottomNav } from "@/components/layout/bottom-nav";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);

  // Unread counters live here, not in the components that display
  // them: the sidebar and the mobile bottom nav both show them, and
  // each hook opens a fixed-name realtime channel that realtime-js
  // dedupes by topic — two subscribers would share one channel and the
  // first to unmount would remove it for both. One subscription each,
  // fanned out as props.
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // h-dvh (not h-screen / 100vh): on mobile Safari 100vh is the height
  // with the browser toolbars hidden, so a 100vh column overflows the
  // visible area by the toolbar height and the bottom of the page (the
  // inbox composer) ends up behind it. dvh tracks the visible viewport
  // as the toolbars come and go.
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* Registers public/sw.js (production only) and shows the
          "new version" toast. Headless. */}
      <ServiceWorkerRegistration />
      <Sidebar
        open={sidebarOpen}
        onClose={closeSidebar}
        totalUnread={totalUnread}
        unreadNotifications={unreadNotifications}
      />
      {/* pb-[--safe-bottom]: keeps the bottom of the content column (the
          inbox composer in particular) above the home indicator when the
          app runs installed on a phone. 0px in a browser tab. */}
      <div className="flex flex-1 flex-col overflow-hidden pb-[var(--safe-bottom)]">
        <Header onOpenSidebar={openSidebar} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {children}
        </main>
        {/* Mobile tab bar — in flow (not fixed) so <main> shrinks to
            make room and nothing renders underneath it. Hidden at lg+
            and while an inbox thread is open. Suspense: it reads
            useSearchParams(), which needs a boundary or the production
            build bails the whole shell to client rendering. */}
        <Suspense fallback={null}>
          <BottomNav
            onOpenMenu={openSidebar}
            totalUnread={totalUnread}
            unreadNotifications={unreadNotifications}
          />
        </Suspense>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
