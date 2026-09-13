"use client";

import { useState, useEffect, useCallback } from "react";
import { Sparkles, Hand, Undo2, Loader2, AlertTriangle, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { isAiReplyReason, type AiReplyEventRow } from "@/lib/ai/reply-events";

// ------------------------------------------------------------
// Account AI status is the same for every conversation, so cache it per
// account and reuse it across thread switches instead of hitting
// /api/ai/config every time the agent opens a chat.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next thread open rather than hiding the
// banner for the whole session.
// ------------------------------------------------------------
interface AiAccountStatus {
  autoReplyOn: boolean;
}
const statusCache = new Map<string, AiAccountStatus>();

async function fetchAiAccountStatus(accountId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return cached;
  try {
    const res = await fetch("/api/ai/config", { cache: "no-store" });
    if (!res.ok) return { autoReplyOn: false }; // don't cache a transient failure
    const j = await res.json();
    const status = {
      // AI auto-reply is "live" only when configured, the master switch
      // is on, and the inbound bot is enabled.
      autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
    };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return { autoReplyOn: false }; // don't cache
  }
}

/** Per-thread status from GET /api/ai/autoreply/[conversationId]. */
interface AiThreadStatus {
  reply_count: number;
  max_replies: number | null;
  cap_reached: boolean;
  last_event: AiReplyEventRow | null;
}

async function fetchAiThreadStatus(
  conversationId: string,
): Promise<AiThreadStatus | null> {
  try {
    const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as AiThreadStatus;
  } catch {
    return null;
  }
}

// Skips the banner already explains through its own state (paused /
// assigned / cap reached), so repeating them as "last attempt skipped"
// would be noise. Everything else — rate-limited, an automation stealing
// the reply, nothing to reply to — is worth a line.
const SELF_EVIDENT_SKIPS = new Set(["human_assigned", "paused", "cap_reached"]);

interface AiThreadBannerProps {
  conversationId: string;
  /** `conversations.ai_autoreply_disabled` — bot paused on this thread. */
  disabled: boolean;
  /** `conversations.ai_handoff_summary` — note the bot left on handoff. */
  handoffSummary?: string | null;
  /** `conversations.ai_reply_count` — replies used on this thread. Passed
   *  from the parent so the realtime conversation UPDATE that follows
   *  each bot reply refreshes the counter without a second subscription. */
  replyCount?: number | null;
  /** Current assignee; when a human owns the thread the bot won't run,
   *  so the "AI active" banner is suppressed. */
  assignedAgentId?: string | null;
  /** The acting agent — "Take over" assigns the thread to them. */
  currentUserId?: string | null;
  /** Called after a successful toggle so the parent can patch its local
   *  conversation state (the realtime UPDATE also arrives, but this keeps
   *  the banner instant). */
  onChange?: (patch: {
    ai_autoreply_disabled: boolean;
    assigned_agent_id?: string | null;
  }) => void;
}

/**
 * Inbox banner that surfaces + controls the AI auto-reply bot per
 * conversation:
 *   - bot active here → "AI is replying automatically" + reply counter
 *     (`used/max`) + [Take over]; when the last attempt on this thread
 *     failed or was skipped for a non-obvious reason, a second line says
 *     why (from `ai_reply_events`).
 *   - bot hit its per-conversation cap → "reached its reply limit
 *     (3/3)" + [Resume AI] (which resets the counter). Before this state
 *     existed the banner kept claiming the bot was replying while it had
 *     silently stopped.
 *   - bot paused here → the handoff note (if any) + [Resume AI]
 * Renders nothing when the account has no auto-reply configured, or when
 * the bot is active but a human already owns the thread (nothing to do).
 */
export function AiThreadBanner({
  conversationId,
  disabled,
  handoffSummary,
  replyCount,
  assignedAgentId,
  currentUserId,
  onChange,
}: AiThreadBannerProps) {
  const t = useTranslations("Inbox.aiBanner");
  const tEvents = useTranslations("AiReplyEvents");
  const { accountId } = useAuth();
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<AiThreadStatus | null>(null);
  // Optimistic local mirror of the pause flag so the banner flips
  // instantly on click; re-seeds whenever the thread (or its server
  // state via realtime) changes.
  const [paused, setPaused] = useState(disabled);
  useEffect(() => setPaused(disabled), [conversationId, disabled]);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then((s) => alive && setAutoReplyOn(s.autoReplyOn));
    return () => {
      alive = false;
    };
  }, [accountId]);

  // Per-thread status: on thread open, and again whenever the parent's
  // reply count moves (each bot reply bumps `ai_reply_count`, which
  // arrives through the conversation realtime UPDATE).
  useEffect(() => {
    if (!autoReplyOn || !conversationId) return;
    let alive = true;
    fetchAiThreadStatus(conversationId).then((s) => {
      if (alive && s) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [autoReplyOn, conversationId, replyCount]);

  // Live: a new attempt row for this thread lands the moment the bot
  // decides (or fails) — no refetch needed, the row is the payload.
  useEffect(() => {
    if (!autoReplyOn || !conversationId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`ai-reply-events:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "ai_reply_events",
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as AiReplyEventRow;
          setStatus((prev) => ({
            reply_count: prev?.reply_count ?? 0,
            max_replies: prev?.max_replies ?? null,
            cap_reached:
              row.reason === "cap_reached" || row.reason === "cap_race"
                ? true
                : (prev?.cap_reached ?? false),
            last_event: row,
          }));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [autoReplyOn, conversationId]);

  const toggle = useCallback(
    async (paused: boolean) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/ai/autoreply/${conversationId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // "Take over" also assigns the thread to the acting agent.
          body: JSON.stringify({ paused, assign_to_me: paused }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          toast.error(j?.error ?? t("updateError"));
          return;
        }
        setPaused(paused);
        if (!paused) {
          // Resuming resets the per-thread counter server-side; mirror it
          // so the cap banner clears without waiting for the refetch.
          setStatus((prev) =>
            prev ? { ...prev, reply_count: 0, cap_reached: false } : prev,
          );
        }
        onChange?.({
          ai_autoreply_disabled: paused,
          // Take over assigns to the acting agent; resume releases only
          // the caller's own assignment. The realtime UPDATE reconciles
          // the exact value either way.
          ...(paused
            ? currentUserId
              ? { assigned_agent_id: currentUserId }
              : {}
            : { assigned_agent_id: null }),
        });
        toast.success(paused ? t("tookOver") : t("resumed"));
      } catch {
        toast.error(t("networkError"));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, currentUserId, onChange, t],
  );

  // Account has no auto-reply → nothing to show. (Still loading → nothing.)
  if (!autoReplyOn) return null;

  // Paused here (a human took over, or the model handed off).
  if (paused) {
    return (
      <Banner tone="muted">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{t("pausedTitle")}</p>
          {handoffSummary && (
            <p className="truncate text-muted-foreground" title={handoffSummary}>
              {handoffSummary}
            </p>
          )}
        </div>
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
          {t("resume")}
        </BannerButton>
      </Banner>
    );
  }

  // Active, but a human already owns it → the bot won't fire; no banner.
  if (assignedAgentId) return null;

  const count = status?.reply_count ?? replyCount ?? 0;
  const max = status?.max_replies ?? null;
  const capReached =
    status?.cap_reached ?? (max !== null && count >= max);

  // Active in principle, but out of replies on this thread: the bot is
  // silent until someone resets it. Say so instead of "replying
  // automatically".
  if (capReached && max !== null) {
    return (
      <Banner tone="warning">
        <Gauge className="h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {t("capReachedTitle", { count, max })}
          </p>
          <p className="truncate text-muted-foreground">{t("capReachedHint")}</p>
        </div>
        <BannerButton onClick={() => toggle(false)} busy={busy} icon={Undo2}>
          {t("resume")}
        </BannerButton>
      </Banner>
    );
  }

  const last = status?.last_event ?? null;
  const showLast =
    last !== null &&
    (last.outcome === "failed" ||
      (last.outcome === "skipped" && !SELF_EVIDENT_SKIPS.has(last.reason)));
  const reasonLabel = last
    ? isAiReplyReason(last.reason)
      ? tEvents(`reasons.${last.reason}`)
      : last.reason
    : "";

  // Active on this thread.
  return (
    <Banner tone={showLast && last?.outcome === "failed" ? "warning" : "primary"}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          <span className="truncate font-medium text-foreground">
            {t("activeText")}
          </span>
          {max !== null && (
            <span className="flex-shrink-0 tabular-nums text-muted-foreground">
              · {t("replyCounter", { count, max })}
            </span>
          )}
        </div>
        {showLast && last && (
          <p
            className={cn(
              "mt-0.5 flex min-w-0 items-center gap-1 truncate",
              last.outcome === "failed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
            title={[reasonLabel, last.detail].filter(Boolean).join(" — ")}
          >
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">
              {last.outcome === "failed"
                ? t("lastAttemptFailed")
                : t("lastAttemptSkipped")}
              : {reasonLabel}
              {last.detail ? ` — ${last.detail}` : ""}
            </span>
          </p>
        )}
      </div>
      <BannerButton onClick={() => toggle(true)} busy={busy} icon={Hand}>
        {t("takeOver")}
      </BannerButton>
    </Banner>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "primary" | "muted" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-3 py-2 text-xs sm:px-4",
        tone === "primary"
          ? "border-primary/20 bg-primary/5"
          : tone === "warning"
            ? "border-amber-500/30 bg-amber-500/10"
            : "border-border bg-muted/40",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Hand;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
