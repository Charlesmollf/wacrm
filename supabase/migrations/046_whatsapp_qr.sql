-- 046 — WhatsApp por QR (proveedor no oficial, por cuenta). 25-11-2026
--
-- Solo para cuentas SIN fila en whatsapp_config (hoy: MR Seguros). Café
-- sigue por Cloud API y no usa ninguna de estas tablas.
-- RLS activo y sin políticas: solo el service role (el servidor) las toca.

CREATE TABLE IF NOT EXISTS wa_qr_session (
  account_id   UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  status       TEXT NOT NULL DEFAULT 'starting',
  qr           TEXT,
  phone        TEXT,
  last_error   TEXT,
  lease_owner  TEXT,
  lease_until  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_qr_auth (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,           -- cifrado con ENCRYPTION_KEY
  PRIMARY KEY (account_id, key)
);

CREATE TABLE IF NOT EXISTS wa_qr_outbox (
  wa_message_id TEXT PRIMARY KEY,     -- se genera antes de enviar
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sending','sent','failed','cancelled')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_qr_outbox_pending
  ON wa_qr_outbox (account_id, created_at) WHERE status = 'pending';

ALTER TABLE wa_qr_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_qr_auth    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_qr_outbox  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wa_qr_session, wa_qr_auth, wa_qr_outbox FROM anon, authenticated;

-- Candado: solo un proceso puede tener el socket. Usa el reloj de la base.
CREATE OR REPLACE FUNCTION wa_qr_acquire_lease(p_account UUID, p_owner TEXT, p_ttl_seconds INT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE wa_qr_session
     SET lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_ttl_seconds)
   WHERE account_id = p_account
     AND enabled
     AND (lease_owner IS NULL OR lease_owner = p_owner OR lease_until < now());
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION wa_qr_acquire_lease(UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wa_qr_acquire_lease(UUID, TEXT, INT) TO service_role;

-- Keepalive cada minuto (requiere pg_cron y pg_net, ya usados por /api/cron/tick).
SELECT cron.schedule(
  'wa-qr-keepalive',
  '* * * * *',
  $cron$
  SELECT net.http_get(
    'https://crm.kaffeejager.shop/api/whatsapp-qr/tick?token=' ||
    (SELECT token::text FROM public.app_cron_auth WHERE id = 1)
  )
  WHERE EXISTS (SELECT 1 FROM public.wa_qr_session WHERE enabled);
  $cron$
);
