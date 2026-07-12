-- 038_deal_lead_fields
-- More lead detail on the deal card (inspired by the Kommo lead view):
--   address       -> delivery address ("Domicilio")
--   nit           -> tax id for invoicing
--   combo_history -> running log of combos the customer has bought over
--                    time (the bot appends "[YYYY-MM-DD] <combo>" lines)
-- All nullable, no CHECK — filled by the user in the deal form and/or by
-- the AI from the conversation (see src/lib/ai/deal-updates.ts).
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS nit text,
  ADD COLUMN IF NOT EXISTS combo_history text;
