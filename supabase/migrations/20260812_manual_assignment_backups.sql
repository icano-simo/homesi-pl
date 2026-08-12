-- Migration: durable backup of manual cost-center assignments across a replace.
--
-- NOT APPLIED. Review before running, and run it against finance_division only.
-- The Postgres project is shared with the other portal apps.
--
-- PROBLEM: replacing an upload hard-deletes its pl_transactions rows, taking
--          every manual and conflict_resolved assignment with them. Until now
--          the only copy lived in a JavaScript array inside the request that
--          was doing the deleting, so a crash, a deploy, or a serverless
--          timeout between deleteUpload() and reapplyManualSnapshot() lost
--          hundreds of hand-made decisions with no way to recover them.
--
-- FIX: write the backup to a table and confirm it before the first delete
--      runs. The reapply then reads from the table rather than from memory,
--      which also makes it resumable — a request that dies half-way leaves
--      rows in 'pending' that a later run picks up.

CREATE TABLE IF NOT EXISTS finance_division.manual_assignment_backups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Upload whose rows were about to be deleted, and the one they were
  -- reapplied onto. No foreign key to pl_uploads on purpose: the replaced
  -- upload is deleted seconds later, and a cascade would destroy the very
  -- backup that exists to survive it.
  replaced_upload_id  UUID NOT NULL,
  new_upload_id       UUID,

  -- ── Match key ─────────────────────────────────────────────────────────────
  -- The four original fields plus year, month, debit and credit. Measured on
  -- production: with only the first four, 228 of 804 assignments matched more
  -- than one expense and the worst group held 732. Adding these four makes the
  -- 196 employee_fee cases unique and 31 of the 36 offshore ones; roughly 5
  -- remain genuinely indistinguishable.
  --
  -- month is TEXT ("March"), not a number — it is stored that way on
  -- pl_transactions and is compared as text here.
  gl_code             TEXT,
  branch              TEXT,
  check_description   TEXT,
  journal_post_date   DATE,
  year                INTEGER,
  month               TEXT,
  debit               NUMERIC(14,2),
  credit              NUMERIC(14,2),

  -- ── What is being preserved ───────────────────────────────────────────────
  assignment_origin   TEXT NOT NULL,

  -- Nullable, matching pl_transactions.cost_center_id. Zero of the 804 current
  -- assignments have a NULL here, but a NOT NULL would turn any future one into
  -- a failed insert — and because the snapshot must succeed before anything is
  -- deleted, that failure would abort the whole upload. Recording the row as it
  -- actually was beats refusing to record it.
  cost_center_id      UUID,

  source_tx_id        UUID NOT NULL,   -- the deleted row, for auditing only
  conflict_snapshot   JSONB,           -- conflict_resolved rows only
  splits              JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ── Outcome ───────────────────────────────────────────────────────────────
  -- pending   : written, not yet reapplied. A run that dies leaves these.
  -- applied   : exactly one new transaction matched; the assignment is back.
  -- ambiguous : several matched. Nothing was written to any of them — see
  --             candidate_tx_ids and decide by hand.
  -- not_found : nothing matched. The expense is not in the new file.
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'applied', 'ambiguous', 'not_found')),
  candidate_tx_ids    UUID[],
  matched_tx_id       UUID,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ
);

-- The reapply asks exactly this: give me the pending rows for the upload I am
-- replacing.
CREATE INDEX IF NOT EXISTS idx_manual_backups_pending
  ON finance_division.manual_assignment_backups (replaced_upload_id)
  WHERE status = 'pending';

-- Answers "what still needs a human?" without scanning the table.
CREATE INDEX IF NOT EXISTS idx_manual_backups_status
  ON finance_division.manual_assignment_backups (status, created_at DESC);

-- Re-running a snapshot for the same upload must not double-insert. The source
-- transaction id is unique within an upload, so it is the natural guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_backups_source
  ON finance_division.manual_assignment_backups (replaced_upload_id, source_tx_id);

-- Same access model as the rest of the schema: reached only through API routes
-- holding the service role.
GRANT ALL ON finance_division.manual_assignment_backups TO service_role;

ALTER TABLE finance_division.manual_assignment_backups ENABLE ROW LEVEL SECURITY;
