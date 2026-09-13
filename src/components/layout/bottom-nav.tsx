"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell, GitBranch, Menu, MessageSquare, Users } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Mobile bottom tab bar — the primary navigation below `lg`, where the
 * sidebar is an off-screen drawer. Renders nothing at `lg` and above
 * (the sidebar is always visible there) and nothing while a
 * conversation thread is open on a phone, so the thread and its
 * composer get the full height.
 *
 * Four destinations plus "More", which opens the same drawer the
 * header's hamburger does — every section the sidebar lists is still
 * reachable, the tabs just put the ones a phone user opens all day
 * one tap away. Unread counts come in as props (the shell owns the two
 * realtime hooks and feeds this and the sidebar from one subscription
 * each — `realtime-js` dedupes channels by topic, so two components
 * each calling the hook would share a channel and the first unmount
 * would tear it down for both).
 *
 * "Thread open" is read from the URL (`/inbox?c=<id>`) rather than
 * from inbox state: the inbox page already mirrors its selection into
 * `?c=` via `router.replace` and clears it on back, so the URL is the
 * one source of truth both surfaces can see without new plumbing.
 */

const TABS = [
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare },
  { href: "/contacts", labelKey: "contacts", icon: Users },
  { href: "/pipelines", labelKey: "pipelines", icon: GitBranch },
  { href: "/notifications", labelKey: "notifications", icon: Bell },
] as const;

interface BottomNavProps {
  /** Opens the sidebar drawer — same handler the header's hamburger uses. */
  onOpenMenu: () => void;
  /** Conversations with unread inbound messages (dot on the Inbox tab). */
  totalUnread: number;
  /** Unread notifications (count pill on the Notifications tab). */
  unreadNotifications: number;
}

export function BottomNav({
  onOpenMenu,
  totalUnread,
  unreadNotifications,
}: BottomNavProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const threadOpen = pathname.startsWith("/inbox") && !!searchParams.get("c");
  if (threadOpen) return null;

  // Same prefix rule the sidebar uses for its active pill.
  const activeHref =
    TABS.find((tab) => pathname.startsWith(tab.href))?.href ?? null;

  return (
    <nav
      aria-label={t("mobileNav")}
      className="flex h-14 shrink-0 items-stretch border-t border-border bg-background lg:hidden"
    >
      {TABS.map((tab) => {
        const isActive = activeHref === tab.href;
        const showUnreadDot =
          tab.href === "/inbox" && totalUnread > 0 && !isActive;
        const showNotificationBadge =
          tab.href === "/notifications" && unreadNotifications > 0;

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
              isActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="relative">
              <tab.icon className="h-5 w-5" />
              {showUnreadDot && (
                <span
                  aria-label={t("unreadConversations", { count: totalUnread })}
                  className="absolute -top-0.5 -right-0.5 flex h-2 w-2"
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              )}
              {showNotificationBadge && (
                <span
                  aria-label={t("unreadNotifications", {
                    count: unreadNotifications,
                  })}
                  className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground"
                >
                  {unreadNotifications > 9 ? "9+" : unreadNotifications}
                </span>
              )}
            </span>
            <span className="truncate">{t(tab.labelKey)}</span>
          </Link>
        );
      })}

      {/* "More" lights up when the current page isn't one of the four
          tabs (Dashboard, Broadcasts, Settings, …) — it's the tab that
          would lead there. */}
      <button
        type="button"
        onClick={onOpenMenu}
        className={cn(
          "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
          activeHref === null
            ? "text-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Menu className="h-5 w-5" />
        <span className="truncate">{t("more")}</span>
      </button>
    </nav>
  );
}
