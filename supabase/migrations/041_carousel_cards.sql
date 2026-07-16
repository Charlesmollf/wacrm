-- Carousel templates: store the card structure synced from Meta so the
-- send path can build the CAROUSEL component (media + buttons per card).
-- Shape: [{ header_format: 'IMAGE'|'VIDEO', body_text, buttons, media_url }]
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS carousel_cards JSONB;
