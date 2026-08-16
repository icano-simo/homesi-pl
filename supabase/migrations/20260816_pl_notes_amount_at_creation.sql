-- Migration: remember what the figure was when a note was written.
--
-- NOT APPLIED. Review before running, and run it against finance_division only.
-- The Postgres project is shared with the other portal apps.
--
-- PROBLEM: a note anchored to a cell describes a figure that is recomputed on
--          every load. Someone writes "check this charge" against 12,400 and a
--          re-upload, a cost-centre reassignment or a GL remap later makes it
--          15,900. Showing only today's figure hides that it moved; and the
--          figure as it was cannot be recovered afterwards, because
--          pl_transactions keeps no history — a replace hard-deletes the rows.
--
-- FIX: store it at creation. That the amount has changed is the most useful
--      thing an old note can tell a reader, and it is exactly the case the
--      fingerprint and orphan machinery was built for.
--
-- NULLABLE ON PURPOSE, and no backfill. Notes written before this column
-- existed genuinely have no such figure, and inventing one — from today's
-- value, or from any reconstruction — would put a number in front of a reader
-- that nobody ever saw. They render as "current amount", with no delta.
--
-- READING THE DELTA. It says "since it was written", not "discrepancy". On a
-- month still open the figure was always going to move, so a difference is not
-- by itself a problem; it is a prompt to look.

ALTER TABLE finance_division.pl_notes
  ADD COLUMN IF NOT EXISTS amount_at_creation NUMERIC(14,2);

COMMENT ON COLUMN finance_division.pl_notes.amount_at_creation IS
  'Figure of the anchored cell when the note was written. NULL for notes '
  'created before this column existed — those show only the current amount.';

-- Same access model as the other tables in this schema: RLS on, zero policies,
-- privileges only for service_role, which every API route carries. Re-stated
-- here because ALTER TABLE does not change them and a reader of this file
-- should not have to go and check.
GRANT ALL ON finance_division.pl_notes TO service_role;

ALTER TABLE finance_division.pl_notes ENABLE ROW LEVEL SECURITY;
