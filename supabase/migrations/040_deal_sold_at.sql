-- 040_deal_sold_at
-- When the AI confirms a sale it writes the total to deals.value and stamps
-- deals.sold_at once, so the Dashboard momentum chart can sum confirmed
-- sales by day. Nullable; only set on confirmation.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS sold_at timestamptz;
