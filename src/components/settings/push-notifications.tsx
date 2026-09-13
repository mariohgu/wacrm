'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  BellRing,
  BellOff,
  ClipboardCopy,
  Loader2,
  RefreshCw,
  Send,
  Smartphone,
  Stethoscope,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import {
  applyWaitingUpdate,
  getCurrentSubscription,
  getServiceWorkerRegistration,
  getVapidPublicKey,
  getWorkerInfo,
  isIOS,
  isPushSupported,
  isStandaloneDisplay,
  subscribeThisDevice,
  unsubscribeThisDevice,
  type WorkerInfo,
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
 *
 * Two traps the "Diagnostics" card exists to surface, because both are
 * invisible from the ladder above:
 *   - A *new* worker version waiting behind the one still in control.
 *     Push events are delivered to the ACTIVE worker; if that one is a
 *     build without a `push` handler, the server sends, the browser
 *     receives, and nothing is shown. The card flags a waiting update
 *     and offers to apply it now.
 *   - The server not actually being configured (env vars set after the
 *     last deploy, or a mistyped subject): reported without echoing
 *     any secret.
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

interface ServerDiagnostics {
  checkedAt: string;
  server: {
    configured: boolean;
    publicKeyPresent: boolean;
    privateKeyPresent: boolean;
    subject: { present: boolean; valid: boolean; kind: string };
    dispatchSecretPresent: boolean;
  };
  copy: { ok: boolean; locale: string; keys: number; error?: string };
  account: { members: number; subscribedDevices: number; unreadConversations: number };
  devices: { id: string; host: string; endpointSuffix: string; userAgent: string | null; createdAt: string; lastSeenAt: string }[];
  devicesError: string | null;
}

interface ClientDiagnostics {
  permission: NotificationPermission | 'unsupported';
  standalone: boolean;
  ios: boolean;
  worker: WorkerInfo;
  subscriptionHost: string | null;
  subscriptionSuffix: string | null;
  userAgent: string;
}

interface Diagnostics {
  client: ClientDiagnostics;
  server: ServerDiagnostics | { error: string };
}

export function PushNotificationsPanel() {
  const t = useTranslations('Settings.push');
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [worker, setWorker] = useState<WorkerInfo | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);

  const refresh = useCallback(async () => {
    if (isIOS() && !isStandaloneDisplay()) return setStatus('ios_not_installed');
    if (!isPushSupported()) return setStatus('unsupported');
    if (!getVapidPublicKey()) return setStatus('not_configured');
    if (!(await getServiceWorkerRegistration())) return setStatus('no_worker');
    setWorker(await getWorkerInfo());
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

  const updateNow = async () => {
    const applied = await applyWaitingUpdate();
    if (!applied) {
      toast.error(t('diagUpdateNone'));
      return;
    }
    // The registration component reloads the page on controllerchange.
    toast.success(t('diagUpdating'));
  };

  const runDiagnostics = async () => {
    setDiagRunning(true);
    try {
      const subscription = isPushSupported() ? await getCurrentSubscription() : null;
      let subscriptionHost: string | null = null;
      if (subscription) {
        try {
          subscriptionHost = new URL(subscription.endpoint).host;
        } catch {
          subscriptionHost = 'unknown';
        }
      }
      const client: ClientDiagnostics = {
        permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
        standalone: isStandaloneDisplay(),
        ios: isIOS(),
        worker: await getWorkerInfo(),
        subscriptionHost,
        subscriptionSuffix: subscription ? subscription.endpoint.slice(-12) : null,
        userAgent: navigator.userAgent,
      };
      setWorker(client.worker);

      let server: Diagnostics['server'];
      try {
        const res = await fetch('/api/push/diagnostics');
        const data = await res.json().catch(() => ({}));
        server = res.ok ? (data as ServerDiagnostics) : { error: data.error ?? `HTTP ${res.status}` };
      } catch (err) {
        server = { error: err instanceof Error ? err.message : String(err) };
      }
      setDiag({ client, server });
    } finally {
      setDiagRunning(false);
    }
  };

  const copyDiagnostics = async () => {
    if (!diag) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      toast.success(t('diagCopied'));
    } catch {
      toast.error(t('diagCopyFailed'));
    }
  };

  const serverDiag = diag && !('error' in diag.server) ? diag.server : null;
  const serverKnowsThisDevice =
    !!serverDiag &&
    !!diag?.client.subscriptionSuffix &&
    serverDiag.devices.some((d) => d.endpointSuffix === diag.client.subscriptionSuffix);
  const yes = t('diagYes');
  const no = t('diagNo');
  const workerLabel = (info: WorkerInfo | null) => {
    if (!info || !info.registered) return t('diagWorkerNone');
    if (!info.activeVersion) return t('diagWorkerOld');
    return t('diagWorkerVersion', { version: info.activeVersion });
  };

  return (
    <div className="space-y-6">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {worker?.updateWaiting && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="flex flex-wrap items-center gap-3 pt-6">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
            <p className="min-w-0 flex-1 text-sm text-foreground">{t('diagUpdateWaitingBody')}</p>
            <Button size="sm" onClick={updateNow}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('diagUpdateNow')}
            </Button>
          </CardContent>
        </Card>
      )}

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

      {/* Diagnostics — everything needed to explain a missing push, copyable as JSON. */}
      <Card className="border-border bg-card">
        <CardContent className="space-y-4 pt-6">
          <StatusBlock icon={Stethoscope} title={t('diagTitle')}>
            <p className="text-sm text-muted-foreground">{t('diagDescription')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" onClick={runDiagnostics} disabled={diagRunning}>
                {diagRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stethoscope className="mr-2 h-4 w-4" />}
                {t('diagRun')}
              </Button>
              {diag && (
                <Button variant="ghost" onClick={copyDiagnostics}>
                  <ClipboardCopy className="mr-2 h-4 w-4" />
                  {t('diagCopy')}
                </Button>
              )}
            </div>
          </StatusBlock>

          {diag && (
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <DiagRow label={t('diagPermission')} value={diag.client.permission} />
              <DiagRow label={t('diagStandalone')} value={diag.client.standalone ? yes : no} />
              <DiagRow label={t('diagWorker')} value={workerLabel(diag.client.worker)} warn={diag.client.worker.registered && !diag.client.worker.activeVersion} />
              <DiagRow label={t('diagUpdateWaiting')} value={diag.client.worker.updateWaiting ? yes : no} warn={diag.client.worker.updateWaiting} />
              <DiagRow
                label={t('diagSubscription')}
                value={diag.client.subscriptionHost ? `${diag.client.subscriptionHost} …${diag.client.subscriptionSuffix}` : t('diagSubscriptionNone')}
                warn={!diag.client.subscriptionHost}
              />
              {serverDiag ? (
                <>
                  <DiagRow label={t('diagServerKnows')} value={serverKnowsThisDevice ? yes : no} warn={!!diag.client.subscriptionHost && !serverKnowsThisDevice} />
                  <DiagRow label={t('diagServerConfig')} value={serverDiag.server.configured ? yes : no} warn={!serverDiag.server.configured} />
                  <DiagRow
                    label={t('diagServerSubject')}
                    value={serverDiag.server.subject.present ? `${serverDiag.server.subject.kind} · ${serverDiag.server.subject.valid ? yes : no}` : no}
                    warn={!serverDiag.server.subject.valid}
                  />
                  <DiagRow label={t('diagServerSecret')} value={serverDiag.server.dispatchSecretPresent ? yes : no} />
                  <DiagRow
                    label={t('diagServerCopy')}
                    value={serverDiag.copy.ok ? `${serverDiag.copy.locale} (${serverDiag.copy.keys})` : (serverDiag.copy.error ?? no)}
                    warn={!serverDiag.copy.ok}
                  />
                  <DiagRow
                    label={t('diagAccount')}
                    value={t('diagAccountValue', {
                      members: serverDiag.account.members,
                      devices: serverDiag.account.subscribedDevices,
                      unread: serverDiag.account.unreadConversations,
                    })}
                  />
                </>
              ) : (
                <DiagRow label={t('diagServerConfig')} value={'error' in diag.server ? diag.server.error : no} warn />
              )}
            </dl>
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

function DiagRow({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={warn ? 'font-medium text-amber-500' : 'text-foreground'}>{value}</dd>
    </>
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
