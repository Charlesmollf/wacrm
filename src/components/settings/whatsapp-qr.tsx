'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface QrState {
  available: boolean;
  active: boolean;
  canManage?: boolean;
  status?: string;
  phone?: string | null;
  qr?: string | null;
  lastError?: string | null;
}

const ETIQUETAS: Record<string, string> = {
  disconnected: 'Desconectado',
  starting: 'Iniciando…',
  qr: 'Esperando que escanees el código',
  connected: 'Conectado',
  reconnecting: 'Reconectando…',
  logged_out: 'Se desvinculó desde el teléfono',
  qr_expired: 'El código venció',
  error: 'Error de conexión',
};

const APAGADOS = ['disconnected', 'logged_out', 'qr_expired'];

/** Solo aparece en cuentas sin API oficial y con el interruptor encendido. */
export function WhatsAppQr() {
  const [state, setState] = useState<QrState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/whatsapp-qr/session').catch(() => null);
    if (res?.ok) setState(await res.json());
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const id = setInterval(() => void load(), 3000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [load]);

  const run = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    const res = await fetch('/api/whatsapp-qr/session', { method }).catch(() => null);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      toast.error(body?.error ?? 'No se pudo completar');
    }
    await load();
    setBusy(false);
  };

  if (!state?.available) return null;
  const status = state.status ?? 'disconnected';
  const apagado = APAGADOS.includes(status);

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">WhatsApp por código QR</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Conexión no oficial, solo para leer y responder a mano. WhatsApp puede restringir el
          número. Los chats personales 1 a 1 que lleguen desde ahora se verán en este CRM.
        </p>
      </div>

      <p className="text-sm text-foreground">
        Estado: <strong>{ETIQUETAS[status] ?? status}</strong>
        {state.phone ? ` · +${state.phone}` : ''}
      </p>
      {state.lastError && <p className="text-xs text-muted-foreground">{state.lastError}</p>}

      {state.qr && (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state.qr} alt="Código QR de WhatsApp" width={288} height={288} className="rounded-md bg-white" />
          <p className="text-sm text-muted-foreground">
            En el teléfono: WhatsApp → Dispositivos vinculados → Vincular un dispositivo.
          </p>
        </div>
      )}

      {state.canManage && (
        <div className="flex gap-2">
          {apagado ? (
            <Button onClick={() => void run('POST')} disabled={busy}>Conectar</Button>
          ) : (
            <Button variant="outline" onClick={() => void run('DELETE')} disabled={busy}>
              Desvincular
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
