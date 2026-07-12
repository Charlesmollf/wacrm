-- 039_conversation_activity
-- Track the last inbound (customer) and last outbound (bot/agent) message
-- times so the pipeline can show a "response due" traffic light: a lead is
-- waiting when last_inbound_at > last_outbound_at, and the elapsed time
-- since last_inbound_at drives green/amber/red.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz;

-- Backfill from existing message history.
UPDATE conversations c SET
  last_inbound_at = (
    SELECT max(created_at) FROM messages m
    WHERE m.conversation_id = c.id AND m.sender_type = 'customer'
  ),
  last_outbound_at = (
    SELECT max(created_at) FROM messages m
    WHERE m.conversation_id = c.id AND m.sender_type IN ('bot', 'agent')
  );
