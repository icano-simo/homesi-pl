-- Migration: Add updated_at tracking for CC assignment changes on pl_transactions.
--
-- PURPOSE: Track exactly when the cost center assignment of a transaction changed
--          (cost_center_id, cost_center_status, or assignment_origin). The timestamp
--          is only bumped for changes to those three fields — not on any generic
--          row update — so it specifically means "when was the CC assignment last changed".
--
-- LIMITATION: Rows that existed before this migration will have updated_at = NOW()
--             (the migration timestamp, 2026-08-02). Historical assignment timestamps
--             for data loaded before this date cannot be recovered. Any timestamp of
--             2026-08-02 on a pre-existing row should be read as "assigned before Aug 2,
--             2026; exact date unknown" — not as the actual assignment time.

-- 1. Add the column (IF NOT EXISTS is idempotent — safe to re-run).
ALTER TABLE pl_transactions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Trigger function: update updated_at only when CC assignment fields change.
CREATE OR REPLACE FUNCTION trg_pl_transactions_cc_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.cost_center_id     IS DISTINCT FROM OLD.cost_center_id  OR
    NEW.cost_center_status IS DISTINCT FROM OLD.cost_center_status OR
    NEW.assignment_origin  IS DISTINCT FROM OLD.assignment_origin
  ) THEN
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Attach trigger (DROP + CREATE is idempotent).
DROP TRIGGER IF EXISTS trg_pl_transactions_cc_updated_at ON pl_transactions;
CREATE TRIGGER trg_pl_transactions_cc_updated_at
  BEFORE UPDATE ON pl_transactions
  FOR EACH ROW
  EXECUTE FUNCTION trg_pl_transactions_cc_updated_at();
