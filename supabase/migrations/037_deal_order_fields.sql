-- 037_deal_order_fields
-- Operational order fields on deals, surfaced on the pipeline cards
-- (inspired by the Kommo lead card): how the customer pays, whether
-- they've paid yet, and grano vs. molido. All nullable — filled by the
-- user today from the deal form; a later step lets the bot fill them
-- from the conversation. No CHECK so values stay flexible.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS payment_status text,
  ADD COLUMN IF NOT EXISTS grind text;
