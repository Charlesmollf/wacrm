-- Server-side scheduled broadcasts: send at a future time via the cron,
-- no browser/session needed. Uses a separate dispatch_status column so the
-- existing `status` column/constraint is untouched.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_payload jsonb,
  ADD COLUMN IF NOT EXISTS dispatch_status text;

CREATE INDEX IF NOT EXISTS idx_broadcasts_dispatch_due
  ON broadcasts (dispatch_status, scheduled_at)
  WHERE dispatch_status = 'scheduled';
