'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CalendarCheck, CheckCircle2, Trash2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { useTranslations } from 'next-intl';

const MASKED_TOKEN = '••••••••••••••••';

export function SalonBookingConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.salonBooking');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [defaultClienteId, setDefaultClienteId] = useState('');
  const [defaultEstadoId, setDefaultEstadoId] = useState('');
  const [defaultServicioId, setDefaultServicioId] = useState('');
  const [defaultServicioPrecio, setDefaultServicioPrecio] = useState('0');
  const [defaultServicioDuracionMin, setDefaultServicioDuracionMin] = useState('30');
  const [defaultStaffId, setDefaultStaffId] = useState('');
  const [isActive, setIsActive] = useState(false);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/salon-booking/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setBaseUrl(data.base_url ?? '');
        setDefaultClienteId(data.default_cliente_id ?? '');
        setDefaultEstadoId(data.default_estado_id ?? '');
        setDefaultServicioId(data.default_servicio_id ?? '');
        setDefaultServicioPrecio(String(data.default_servicio_precio ?? 0));
        setDefaultServicioDuracionMin(String(data.default_servicio_duracion_min ?? 30));
        setDefaultStaffId(data.default_staff_id ?? '');
        setIsActive(!!data.is_active);
        setHasStoredToken(Boolean(data.has_token));
        setToken(data.has_token ? MASKED_TOKEN : '');
        setTokenEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const tokenPayload = () => (tokenEdited ? token.trim() : undefined);

  const buildBody = () => ({
    base_url: baseUrl.trim(),
    api_token: tokenPayload(),
    default_cliente_id: defaultClienteId.trim(),
    default_estado_id: defaultEstadoId.trim(),
    default_servicio_id: defaultServicioId.trim(),
    default_servicio_precio: Number(defaultServicioPrecio) || 0,
    default_servicio_duracion_min: Number(defaultServicioDuracionMin) || 30,
    default_staff_id: defaultStaffId.trim() || null,
    is_active: isActive,
  });

  const handleTest = async () => {
    if (!baseUrl.trim()) {
      toast.error(t('missingBaseUrl'));
      return;
    }
    setTesting(true);
    try {
      const res = await fetch('/api/salon-booking/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          api_token: tokenPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess'));
      else toast.error(data.error ?? t('testRejected'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!baseUrl.trim()) {
      toast.error(t('missingBaseUrl'));
      return;
    }
    if (!defaultClienteId.trim() || !defaultEstadoId.trim() || !defaultServicioId.trim()) {
      toast.error(t('missingDefaults'));
      return;
    }
    if (!configured && !tokenEdited) {
      toast.error(t('missingToken'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/salon-booking/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/salon-booking/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasStoredToken(false);
        setToken('');
        setTokenEdited(false);
        setIsActive(false);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarCheck className="h-4 w-4 text-primary" /> {t('connectionCard')}
            </CardTitle>
            <CardDescription>{t('encryptionNotice')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="salon-base-url">{t('baseUrl')}</Label>
              <Input
                id="salon-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://example.com/api/v1/ms"
                disabled={disabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="salon-token">{t('apiToken')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="salon-token"
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setTokenEdited(true);
                    }}
                    onFocus={() => {
                      if (!tokenEdited && hasStoredToken) {
                        setToken('');
                        setTokenEdited(true);
                      }
                    }}
                    placeholder={t('tokenPlaceholder')}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showToken ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testConnection')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('tokenHint')}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('defaultsCard')}</CardTitle>
            <CardDescription>{t('defaultsDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="salon-cliente">{t('defaultClienteId')}</Label>
                <Input
                  id="salon-cliente"
                  value={defaultClienteId}
                  onChange={(e) => setDefaultClienteId(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="salon-estado">{t('defaultEstadoId')}</Label>
                <Input
                  id="salon-estado"
                  value={defaultEstadoId}
                  onChange={(e) => setDefaultEstadoId(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="salon-servicio">{t('defaultServicioId')}</Label>
                <Input
                  id="salon-servicio"
                  value={defaultServicioId}
                  onChange={(e) => setDefaultServicioId(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="salon-staff">{t('defaultStaffId')}</Label>
                <Input
                  id="salon-staff"
                  value={defaultStaffId}
                  onChange={(e) => setDefaultStaffId(e.target.value)}
                  placeholder={t('defaultStaffIdPlaceholder')}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="salon-precio">{t('defaultServicioPrecio')}</Label>
                <Input
                  id="salon-precio"
                  type="number"
                  min={0}
                  step="0.01"
                  value={defaultServicioPrecio}
                  onChange={(e) => setDefaultServicioPrecio(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="salon-duracion">{t('defaultServicioDuracion')}</Label>
                <Input
                  id="salon-duracion"
                  type="number"
                  min={1}
                  value={defaultServicioDuracionMin}
                  onChange={(e) => setDefaultServicioDuracionMin(e.target.value)}
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enableBooking')}</p>
                <p className="text-xs text-muted-foreground">{t('enableBookingDesc')}</p>
              </div>
              <Switch checked={isActive} onCheckedChange={setIsActive} disabled={disabled} />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
