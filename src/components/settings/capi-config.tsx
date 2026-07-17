'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, ExternalLink, TrendingUp, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

/**
 * Meta Conversions API card. Lets the owner wire the pixel dataset + a
 * Conversions API access token so confirmed payments report a Purchase
 * back to Meta and the Click-to-WhatsApp campaigns optimize for real sales.
 */
export function CapiConfig() {
  const [datasetId, setDatasetId] = useState('');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [alertEmail, setAlertEmail] = useState('');
  const [resendKey, setResendKey] = useState('');
  const [hasResend, setHasResend] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/capi', { method: 'GET' });
      const json = await res.json().catch(() => null);
      if (res.ok && json) {
        setDatasetId(json.dataset_id ?? '');
        setHasToken(!!json.has_token);
        setAlertEmail(json.alert_email ?? '');
        setHasResend(!!json.has_resend);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    const payload: {
      dataset_id: string;
      access_token?: string;
      alert_email?: string;
      resend_api_key?: string;
    } = {
      dataset_id: datasetId.trim(),
      alert_email: alertEmail.trim(),
    };
    if (token.trim()) payload.access_token = token.trim();
    if (resendKey.trim()) payload.resend_api_key = resendKey.trim();
    try {
      const res = await fetch('/api/whatsapp/capi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        toast.error(json?.error ?? 'No se pudo guardar.');
      } else {
        toast.success('Configuración guardada.');
        setToken('');
        setResendKey('');
        if (payload.access_token) setHasToken(true);
        if (payload.resend_api_key) setHasResend(true);
      }
    } catch {
      toast.error('Error de red al guardar.');
    } finally {
      setSaving(false);
    }
  }, [datasetId, token]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          Conversiones de Meta (Ads)
        </CardTitle>
        <CardDescription>
          Al confirmar un pago, envía una señal de compra a Meta para que tus
          campañas de clic a WhatsApp optimicen hacia ventas reales.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="capi-dataset">ID del conjunto de datos (pixel)</Label>
          <Input
            id="capi-dataset"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            placeholder="p. ej. 1066253287683027"
            disabled={loading || saving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="capi-token">
            Token de Conversions API{' '}
            {hasToken ? (
              <span className="inline-flex items-center gap-1 text-xs text-primary">
                <CheckCircle2 className="h-3.5 w-3.5" /> guardado
              </span>
            ) : null}
          </Label>
          <Input
            id="capi-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? '•••••••• (déjalo vacío para no cambiar)' : 'Pega tu token aquí'}
            disabled={loading || saving}
          />
          <p className="text-xs text-muted-foreground">
            Genéralo en Meta Events Manager → tu conjunto de datos →
            Configuración → API de conversiones → Generar token de acceso.
          </p>
          <a
            href="https://business.facebook.com/events_manager2/list/dataset/1066253287683027/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Abrir Events Manager <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="space-y-4 border-t border-border pt-4">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <TrendingUp className="h-4 w-4 text-primary" />
              Alerta de pago por correo
            </h4>
            <p className="text-xs text-muted-foreground">
              Te avisamos al instante cuando un pedido entra a &quot;Confirmar
              pagos&quot;. Crea una cuenta gratis en Resend con este mismo
              correo y pega la API key.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="alert-email">Correo para la alerta</Label>
            <Input
              id="alert-email"
              type="email"
              value={alertEmail}
              onChange={(e) => setAlertEmail(e.target.value)}
              placeholder="kaffeejager@gmail.com"
              disabled={loading || saving}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="resend-key">
              Resend API key{' '}
              {hasResend ? (
                <span className="inline-flex items-center gap-1 text-xs text-primary">
                  <CheckCircle2 className="h-3.5 w-3.5" /> guardada
                </span>
              ) : null}
            </Label>
            <Input
              id="resend-key"
              type="password"
              value={resendKey}
              onChange={(e) => setResendKey(e.target.value)}
              placeholder={hasResend ? '•••••••• (déjalo vacío para no cambiar)' : 're_...'}
              disabled={loading || saving}
            />
            <a
              href="https://resend.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Crear API key en Resend <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>

        <Button onClick={save} disabled={loading || saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}
