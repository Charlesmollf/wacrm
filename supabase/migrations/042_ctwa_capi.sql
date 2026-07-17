-- Click-to-WhatsApp attribution + Meta Conversions API (server-side Purchase).
-- Capture the ad click id on the conversation, and store the dataset id +
-- optional dedicated CAPI token on the WhatsApp config.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ctwa_clid text,
  ADD COLUMN IF NOT EXISTS ctwa_source_id text,
  ADD COLUMN IF NOT EXISTS ctwa_source_type text,
  ADD COLUMN IF NOT EXISTS ctwa_captured_at timestamptz;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS capi_dataset_id text,
  ADD COLUMN IF NOT EXISTS capi_access_token text;
