'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Activity, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';
import {
  isAiReplyReason,
  type AiReplyEventRow,
  type AiReplyOutcome,
} from '@/lib/ai/reply-events';

interface EventWithContact extends AiReplyEventRow {
  conversation: {
    id: string;
    contact: { id: string; name: string | null; phone: string | null } | null;
  } | null;
}

interface ActivityResponse {
  window_days: number;
  truncated: boolean;
  total: number;
  by_reason: { outcome: AiReplyOutcome; reason: string; count: number }[];
  events: EventWithContact[];
}

const OUTCOME_CLASS: Record<AiReplyOutcome, string> = {
  replied: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  handoff: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  skipped: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  failed: 'bg-destructive/15 text-destructive',
};

/**
 * Agents → Usage: account-wide feed of auto-reply attempts
 * (`ai_reply_events`). Admin-only, same gate as the token-usage card it
 * sits next to. Answers "why did the bot go quiet?" at the account level
 * — a tally by outcome/reason for the window, then the most recent
 * attempts with the contact and the failure detail.
 */
export function AiReplyActivityCard() {
  const t = useTranslations('AiReplyEvents');
  const { accountId, accountRole, profileLoading } = useAuth();
  const canView = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ActivityResponse | null>(null);
  const loadedRef = useRef<string | null>(null);

  const fetchActivity = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/autoreply/events?days=7&limit=50', {
        cache: 'no-store',
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(json?.error ?? t('loadError'));
        setData(null);
        return;
      }
      setData(json as ActivityResponse);
    } catch {
      toast.error(t('loadError'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!canView || !accountId) return;
    if (loadedRef.current === accountId) return;
    loadedRef.current = accountId;
    void fetchActivity();
  }, [canView, accountId, fetchActivity]);

  if (profileLoading || !canView) return null;

  const outcomeLabel = (o: AiReplyOutcome) => t(`outcomes.${o}`);
  const reasonLabel = (r: string) =>
    isAiReplyReason(r) ? t(`reasons.${r}`) : r;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-primary" /> {t('title')}
            </CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </div>
          <button
            type="button"
            onClick={() => void fetchActivity()}
            disabled={loading}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading || !data ? (
          <Skeleton className="h-[160px] w-full" />
        ) : data.total === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Activity className="h-8 w-8 opacity-40" />
            <p>{t('empty', { days: data.window_days })}</p>
            <p className="text-xs">{t('emptyHint')}</p>
          </div>
        ) : (
          <>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t('byReason')}
              </p>
              <ul className="divide-y divide-border rounded-md border border-border">
                {data.by_reason.map((r) => (
                  <li
                    key={`${r.outcome}:${r.reason}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <OutcomeBadge outcome={r.outcome} label={outcomeLabel(r.outcome)} />
                      <span className="truncate text-foreground">
                        {reasonLabel(r.reason)}
                      </span>
                    </span>
                    <span className="flex-shrink-0 tabular-nums text-muted-foreground">
                      {r.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t('recent')}
              </p>
              <ul className="divide-y divide-border rounded-md border border-border">
                {data.events.map((e) => {
                  const contact = e.conversation?.contact;
                  const who =
                    contact?.name || contact?.phone || t('unknownContact');
                  return (
                    <li key={e.id} className="px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <OutcomeBadge
                            outcome={e.outcome}
                            label={outcomeLabel(e.outcome)}
                          />
                          <span className="truncate font-medium text-foreground">
                            {who}
                          </span>
                        </span>
                        <span
                          className="flex-shrink-0 text-xs text-muted-foreground"
                          title={e.created_at}
                        >
                          {formatDistanceToNow(parseISO(e.created_at), {
                            addSuffix: true,
                          })}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {reasonLabel(e.reason)}
                        {e.detail ? ` — ${e.detail}` : ''}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>

            {(data.truncated || data.total > data.events.length) && (
              <p className="text-xs text-muted-foreground">{t('truncated')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function OutcomeBadge({
  outcome,
  label,
}: {
  outcome: AiReplyOutcome;
  label: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        OUTCOME_CLASS[outcome],
      )}
    >
      {label}
    </span>
  );
}
