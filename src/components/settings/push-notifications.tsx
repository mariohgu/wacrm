'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { BellRing, BellOff, Loader2, Send, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import {
  getCurrentSubscription,
  getServiceWorkerRegistration,
  getVapidPublicKey,
  isIOS,
  isPushSupported,
  isStandaloneDisplay,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from '@/lib/push/client';

/**
 * Settings → Push notifications. Per *device*, not per account: a
 * subscription belongs to the browser it was created in, so this panel
 * talks about "this device" and a user enables it on each phone/laptop
 * they want pinged.
 *
 * The status ladder (checked in this order, first match wins):
 *   ios_not_installed — iPhone/iPad in a browser tab. iOS only delivers
 *                       push to the installed app, so the panel shows
 *                       the install steps instead of a dead button.
 *   unsupported       — no Push API in this browser.
 *   not_configured    — the server has no VAPID keys (self-hoster
 *                       hasn't set the env vars yet).
 *   no_worker         — our service worker isn't registered here (dev
 *                       builds never register it; or a very first load).
 *   denied            — the user blocked notifications at the browser
 *                       level; only they can undo that.
 *   enabled / disabled — subscribed here or not.
 */
type Status =
  | 'loading'
  | 'ios_not_installed'
  | 'unsupported'
  | 'not_configured'
  | 'no_worker'
  | 'denied'
  | 'enabled'
  | 'disabled';

export function PushNotificationsPanel() {
  const t = useTranslations('Settings.push');
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(async () => {
    if (isIOS() && !isStandaloneDisplay()) return setStatus('ios_not_installed');
    if (!isPushSupported()) return setStatus('unsupported');
    if (!getVapidPublicKey()) return setStatus('not_configured');
    if (!(await getServiceWorkerRegistration())) return setStatus('no_worker');
    if (Notification.permission === 'denied') return setStatus('denied');
    setStatus((await getCurrentSubscription()) ? 'enabled' : 'disabled');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    setBusy(true);
    try {
      const result = await subscribeThisDevice();
      if (result === 'subscribed') {
        toast.success(t('enabledToast'));
      } else if (result === 'denied') {
        toast.error(t('deniedToast'));
      }
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('enableFailed'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await unsubscribeThisDevice();
      toast.success(t('disabledToast'));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('testFailed'));
      } else if (data.sent > 0) {
        toast.success(t('testSent', { count: data.sent }));
      } else {
        toast.error(t('testNoDevice'));
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card className="border-border bg-card">
        <CardContent className="space-y-4 pt-6">
          {status === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('checking')}
            </div>
          )}

          {status === 'ios_not_installed' && (
            <StatusBlock icon={Smartphone} title={t('iosTitle')}>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>{t('iosStep1')}</li>
                <li>{t('iosStep2')}</li>
                <li>{t('iosStep3')}</li>
              </ol>
            </StatusBlock>
          )}

          {status === 'unsupported' && (
            <StatusBlock icon={BellOff} title={t('unsupportedTitle')}>
              <p className="text-sm text-muted-foreground">{t('unsupportedBody')}</p>
            </StatusBlock>
          )}

          {status === 'not_configured' && (
            <StatusBlock icon={BellOff} title={t('notConfiguredTitle')}>
              <p className="text-sm text-muted-foreground">{t('notConfiguredBody')}</p>
            </StatusBlock>
          )}

          {status === 'no_worker' && (
            <StatusBlock icon={BellOff} title={t('noWorkerTitle')}>
              <p className="text-sm text-muted-foreground">{t('noWorkerBody')}</p>
            </StatusBlock>
          )}

          {status === 'denied' && (
            <StatusBlock icon={BellOff} title={t('deniedTitle')}>
              <p className="text-sm text-muted-foreground">{t('deniedBody')}</p>
            </StatusBlock>
          )}

          {status === 'disabled' && (
            <StatusBlock icon={BellRing} title={t('disabledTitle')}>
              <p className="text-sm text-muted-foreground">{t('disabledBody')}</p>
              <Button onClick={enable} disabled={busy} className="mt-3">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BellRing className="mr-2 h-4 w-4" />}
                {t('enableButton')}
              </Button>
            </StatusBlock>
          )}

          {status === 'enabled' && (
            <StatusBlock icon={BellRing} title={t('enabledTitle')} accent>
              <p className="text-sm text-muted-foreground">{t('enabledBody')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" onClick={sendTest} disabled={testing}>
                  {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  {t('testButton')}
                </Button>
                <Button variant="ghost" onClick={disable} disabled={busy}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BellOff className="mr-2 h-4 w-4" />}
                  {t('disableButton')}
                </Button>
              </div>
            </StatusBlock>
          )}
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardContent className="space-y-2 pt-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">{t('whatTitle')}</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t('whatBadge')}</li>
            <li>{t('whatQuiet')}</li>
            <li>{t('whatLoud')}</li>
            <li>{t('whatAttention')}</li>
          </ul>
          <p className="pt-2 text-xs">{t('iosNote')}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBlock({
  icon: Icon,
  title,
  accent = false,
  children,
}: {
  icon: typeof BellRing;
  title: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div
        className={
          accent
            ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary'
            : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground'
        }
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}
