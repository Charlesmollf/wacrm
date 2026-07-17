-- Email alert when a deal enters the "Confirmar pagos" queue.
-- Stores the Resend API key (encrypted) and the destination alert email.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS resend_api_key text,
  ADD COLUMN IF NOT EXISTS alert_email text;
