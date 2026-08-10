-- Migration: pl_notes — drill-down notes anchored to semantic dimensions.
--
-- PURPOSE: Let users comment on any cell of the P&L pivot at any level of
--          aggregation (individual transaction, GL code, Category 7, Category 6,
--          cost center, grand total).
--
-- WHERE NOTES LIVE: only the P&L Notes view (app/pl-notes), whose hierarchy is
--          fixed at Cost Center → Category 6 → Category 7 → GL Code →
--          Description. P&L All and Cost Center Report let the user rearrange
--          the levels, and there the same note would surface on a
--          differently-shaped row from one day to the next while the figure
--          behind it never moved — confusing enough that those two reports stay
--          read-only, with no clickable cells and no indicators.
--
--          Even with the hierarchy fixed, a note is still NOT anchored to a
--          position in the tree ("row 4 of level 2"). Anchoring by dimensions
--          keeps notes valid if the fixed hierarchy is ever revised, and lets a
--          note survive re-categorization of its transactions.
--
-- ANCHORING MODEL: each note stores the full conjunction of dimension
--          constraints that define its cell, e.g.
--            {"category_2":"Income","category_6":"Revenue","month":"April","year":2026}
--          A note N is shown under cell C when scope(N) ⊇ scope(C) — that is,
--          N carries every constraint of C with the same value (and possibly
--          more). More constraints = more specific = a subset of transactions,
--          so notes roll UP the tree and never leak downward.
--
--          Consequence: a transaction-level note must carry the full dimension
--          map of its transaction (not just transaction_id), otherwise it would
--          never satisfy the superset test against an aggregate cell and would
--          never roll up. The application derives that map live from the loaded
--          transaction; the stored scope is the fallback for orphaned notes.
--
-- STABLE VALUES: scope stores stable identifiers, not display labels —
--          gl_code (not "41309 — Origination Income") and cost_center_id (not
--          the cost center name) — so renaming a GL or a cost center does not
--          detach existing notes.

CREATE TABLE IF NOT EXISTS pl_notes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Coarse level of the anchor. Denormalized for filtering/indexing only;
  -- the authoritative anchor is `scope`. Derivable from scope at any time.
  level          TEXT NOT NULL,

  -- The anchor: conjunction of dimension constraints defining the cell.
  scope          JSONB NOT NULL,

  -- Deterministic serialization of `scope` (keys sorted, values URI-encoded,
  -- joined by "|"). JSONB equality is unreliable for this — key order is not
  -- guaranteed and 2026 vs "2026" compare unequal — so exact "is there a note
  -- on precisely this cell" lookups go through this column instead.
  -- NOT unique: several notes on the same cell form a comment thread.
  scope_key      TEXT NOT NULL,

  -- Only for level='transaction'. ON DELETE SET NULL, deliberately NOT CASCADE:
  -- deleteUpload() hard-deletes pl_transactions rows when a month is re-uploaded
  -- (see lib/check-duplicate-upload.ts), and CASCADE would silently destroy the
  -- user's comments. The note survives orphaned instead, and the sweep described
  -- below reattaches it. Aggregate-level notes never depend on transaction UUIDs
  -- and survive a re-upload untouched.
  transaction_id UUID REFERENCES pl_transactions(id) ON DELETE SET NULL,

  -- Content hash of the underlying transaction, stable across re-uploads:
  -- gl_code | ref_numb | journal_post_date | debit | credit | check_description.
  -- Computed by lib/tx-fingerprint.ts, the single definition of "same
  -- transaction" in this project.
  --
  -- Consumed by relinkOrphanNotes() in lib/relink-orphan-notes.ts, which runs
  -- after every upload (step 7c/7d of the upload routes): it fingerprints the
  -- newly inserted rows and reattaches orphaned notes on an exact single match.
  -- Zero matches or several matches both leave the note orphaned — identical
  -- lines on the same day are normal in a GL detail, and guessing would move a
  -- comment onto the wrong transaction. Those surface in the Orphaned Notes
  -- panel in P&L Notes for a human to place or discard.
  --
  -- Added 2026-08-07 together with orphaned_at; before that this column was
  -- written but never read, so orphaned notes were invisible.
  tx_fingerprint TEXT,

  note_text      TEXT NOT NULL,
  author         TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Exact-cell lookup ("notes written directly on this cell").
CREATE INDEX IF NOT EXISTS idx_pl_notes_scope_key ON pl_notes(scope_key);

-- Containment queries over individual dimensions, e.g. scope @> '{"month":"April"}'.
CREATE INDEX IF NOT EXISTS idx_pl_notes_scope ON pl_notes USING GIN(scope);

-- Re-linking orphaned notes after a re-upload, and transaction-level fast path.
CREATE INDEX IF NOT EXISTS idx_pl_notes_tx          ON pl_notes(transaction_id);
CREATE INDEX IF NOT EXISTS idx_pl_notes_fingerprint ON pl_notes(tx_fingerprint);

-- Reuse the existing updated_at helper from schema.sql.
DROP TRIGGER IF EXISTS pl_notes_updated_at ON pl_notes;
CREATE TRIGGER pl_notes_updated_at
  BEFORE UPDATE ON pl_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
