-- 045 — Espera del bot y registro de fallos (24-09-2026)
--
-- 1) messages.received_at: hora en que el mensaje LLEGO al servidor.
--    `created_at` guarda la hora de WhatsApp (segundos, puede venir atrasada)
--    y no sirve para saber si el cliente escribio algo DESPUES. El debounce
--    del bot compara con esta columna.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_messages_conv_customer_received
  ON messages (conversation_id, received_at DESC)
  WHERE sender_type = 'customer';

-- 2) ai_failures: cada vez que el bot NO pudo contestar a un cliente.
--    Antes solo quedaba en los logs de Hostinger y nadie se enteraba.
CREATE TABLE IF NOT EXISTS ai_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID,
  conversation_id UUID,
  contact_id UUID,
  etapa TEXT NOT NULL,          -- 'modelo' | 'respaldo' | 'dispatch'
  modelo TEXT,
  error TEXT,
  respondio_respaldo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_failures_created ON ai_failures (created_at DESC);

ALTER TABLE ai_failures ENABLE ROW LEVEL SECURITY;
