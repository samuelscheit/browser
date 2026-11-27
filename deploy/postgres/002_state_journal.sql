-- Incremental state journal: each control-plane transaction appends one delta; full checkpoints
-- in fabric_state_snapshots are written only every few hundred transactions. A process loads the
-- latest checkpoint and replays the deltas after it.
CREATE TABLE IF NOT EXISTS fabric_state_deltas (
  sequence bigint PRIMARY KEY,
  delta jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
