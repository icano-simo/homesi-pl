-- Migration: track when a transaction-level note lost its transaction.
--
-- CONTEXT: pl_notes.transaction_id is ON DELETE SET NULL, so re-uploading a
--          month (deleteUpload hard-deletes pl_transactions) leaves the note
--          alive but detached. Until now nothing recorded that this happened
--          and nothing tried to reattach it, so the note simply vanished from
--          the UI. This column is what makes an orphan visible and sortable.
--
-- NOT NULLABLE-BY-MEANING: orphaned_at IS NULL means "attached, or never was a
--          transaction note". Aggregate notes (GL, category, cost center) and
--          per-entity logs keep it NULL forever — they carry no transaction_id
--          and no tx_fingerprint, so they can never be orphaned.

ALTER TABLE pl_notes
  ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Notes already detached by an earlier re-upload. Their real orphaning moment
-- is unrecoverable, so they are stamped NOW() and should be read as "orphaned
-- at or before this migration; exact time unknown" — the same caveat the
-- 2026-08-02 updated_at migration carries.
UPDATE pl_notes
   SET orphaned_at = NOW()
 WHERE transaction_id IS NULL
   AND tx_fingerprint IS NOT NULL
   AND orphaned_at IS NULL;

-- ── Sweep index ─────────────────────────────────────────────────────────────
-- The re-link step runs on every upload and asks exactly this question.
-- Partial, so it indexes only the orphans rather than the whole table.
CREATE INDEX IF NOT EXISTS idx_pl_notes_orphans
  ON pl_notes (tx_fingerprint)
  WHERE transaction_id IS NULL AND tx_fingerprint IS NOT NULL;

-- ── Automatic stamping ──────────────────────────────────────────────────────
-- Stamping orphaned_at during the next upload would record when someone
-- happened to upload, not when the note was actually orphaned. The FK's SET
-- NULL fires a real UPDATE on this table, so a row trigger can capture the true
-- moment instead, and clear it the instant the note is reattached.
-- relinkOrphanNotes() keeps its own "stamp if still null" as a backstop for
-- rows detached before this trigger existed.
CREATE OR REPLACE FUNCTION trg_pl_notes_orphaned_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.transaction_id IS NOT NULL AND NEW.transaction_id IS NULL THEN
    NEW.orphaned_at := NOW();
  ELSIF NEW.transaction_id IS NOT NULL THEN
    NEW.orphaned_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pl_notes_orphaned_at ON pl_notes;
CREATE TRIGGER pl_notes_orphaned_at
  BEFORE UPDATE ON pl_notes
  FOR EACH ROW EXECUTE FUNCTION trg_pl_notes_orphaned_at();
