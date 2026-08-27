-- ═══════════════════════════════════════════════════════════════════════════
-- lo_payroll_aliases — the name equivalences a human has confirmed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR
--
-- The payroll writes a person's name one way and loan_officials writes it
-- another, and neither is wrong:
--
--     payroll          "LAINO CHEGWIN, GIAN L"   "BADOVINAC, STEVEN P"
--     loan_officials   "Gian Laino"              "Steve Badovinac"
--
-- A rule that requires a shared surname and a shared given name pairs 29 of the
-- 46 loan officers with no guessing at all. This table exists for the ones it
-- cannot settle, and ONLY for those — and not even for all of them: four are a
-- data typo that must be fixed at the source, see the block after the table.
--
-- WHY A TABLE AND NOT A SIMILARITY SCORE
--
-- Because the payroll holds "CASTRO, JULY M" and "CASTRO, JUSETH M", two
-- different people, and "Julymar Mar Castro" is one of them. Any fuzzy ranking
-- has a real chance of picking the wrong one, and a wrong match is worse than
-- no match: it hands one person's salary to another and nothing on screen says
-- so. Every row here is a decision somebody made and can be argued with.
--
-- WHY A TABLE AND NOT A CONSTANT IN THE CODE
--
-- It changes when people are hired, not when the software changes, so it must
-- not need a deploy. And it is small: two rows are known to be needed today.
--
--     "BADOVINAC, STEVEN P"   -> "Steve Badovinac"     (Steve / Steven)
--     "CASTRO, JULY M"        -> "Julymar Mar Castro"  (the decoy above)
--
-- They are NOT inserted here. Adding them is a judgement about who two people
-- are, and that belongs to whoever knows, not to a migration.
--
-- The other eleven unmatched officers are not this table's problem: their
-- surname does not appear in the compensation accounts at all, and seven of
-- them appear nowhere in the entire P&L. They have no compensation recorded,
-- which is a finding rather than a gap.
--
-- NOT EXECUTED. Review and apply it yourself, as with the backups table.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance_division.lo_payroll_aliases (
  id            uuid primary key default gen_random_uuid(),

  -- The description exactly as the payroll writes it, kept verbatim so a row
  -- can be traced back to the ledger by eye. Matching normalizes case and
  -- accents anyway, so the stored form is for humans, not for the join.
  payroll_name  text not null,

  -- The loan_officer exactly as loan_officials writes it.
  loan_officer  text not null,

  -- Why somebody decided these are the same person. Not decoration: the next
  -- reader has to be able to disagree with the reason, and "Steve is Steven"
  -- and "confirmed with HR" are very different grounds.
  note          text,

  created_at    timestamptz not null default now(),
  created_by    text,

  -- One payroll person maps to one officer and one officer to one payroll
  -- person. Both directions are constrained because the matcher requires a 1:1
  -- pairing, and a many-to-one here would double-count somebody's pay.
  constraint lo_payroll_aliases_payroll_unique unique (payroll_name),
  constraint lo_payroll_aliases_officer_unique unique (loan_officer)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS TABLE MUST NOT BE USED FOR: the duplicated officers
-- ═══════════════════════════════════════════════════════════════════════════
--
-- loan_officials carries two people under two spellings each. Measured:
--
--     Galo Rizzo               26 closings   branch 747   Nov 2025 - Jul 2026
--     Galo Rizzo Hinojosa       1 closing    branch 747   Jul 2026
--
--     Frank Rodriguez           7 closings   branches 716, 741, 747
--     Frank Enrique Rodriguez   1 closing    branch 747   Jan 2026
--
-- One spelling carries almost everything and the other carries exactly one
-- closing, on a branch the main spelling already works. That is a capture typo,
-- not two people.
--
-- IT IS NOT A PAYROLL PROBLEM, SO IT IS NOT THIS TABLE'S PROBLEM. The typo
-- splits the CLOSINGS themselves, everywhere in the application that groups by
-- loan officer — loan count, validation, any per-officer figure. The Loan
-- Officer P&L is only where it happened to become visible, because its control
-- total refuses to balance while one payroll person is claimed by two names.
--
-- DO NOT "FIX" IT WITH A ROW HERE. An alias would pair one spelling with the
-- payroll and make this screen look settled, while the other spelling kept its
-- single closing and every other screen kept counting two officers. The symptom
-- would go and the fault would stay, harder to find for having been hidden.
--
-- It gets corrected at the source, when BigQuery is connected. Until then the
-- four names stay undecided and visible on screen, which is the honest state:
-- the software cannot tell whether two names are one person, and guessing is
-- what this whole module refuses to do.
-- ═══════════════════════════════════════════════════════════════════════════

comment on table finance_division.lo_payroll_aliases is
  'Human-confirmed equivalences between a payroll check_description and a loan_officials.loan_officer. Only for names the surname+given rule cannot settle; never generated by similarity.';

comment on column finance_division.lo_payroll_aliases.note is
  'Why these are the same person. Required reading before trusting the row.';

comment on constraint lo_payroll_aliases_officer_unique on finance_division.lo_payroll_aliases is
  'One officer, one payroll person. Blocks the double count that two spellings of one officer would otherwise cause: Galo Rizzo (26 closings) / Galo Rizzo Hinojosa (1), Frank Rodriguez (7) / Frank Enrique Rodriguez (1). Those four are a capture typo affecting closings across the whole app and are NOT to be resolved with a row in this table — that would hide it here and leave it everywhere else. Fixed at the source when BigQuery is connected.';

-- ── Row level security ─────────────────────────────────────────────────────
-- RLS on, NO policies, privileges granted to service_role only. That is the
-- shape every other table in this schema has — measured before writing this:
-- 18 tables, 18 with RLS, 0 policies in the whole schema.
--
-- No policy for service_role, deliberately. service_role bypasses RLS, so such
-- a policy grants nothing; it would only be the first policy in the schema and
-- would make the next reader wonder which of the two mechanisms is doing the
-- work here. With zero policies, RLS closes the table to everyone and the
-- grants below are the only thing that opens it — one mechanism, visible.
--
-- No `grant usage on schema` either: service_role already holds USAGE on
-- finance_division, checked with has_schema_privilege before removing the line.
-- Re-granting an existing privilege reads as a requirement rather than a
-- no-op, and the next person copies it.

alter table finance_division.lo_payroll_aliases enable row level security;

grant select, insert, update, delete on finance_division.lo_payroll_aliases to service_role;

-- ── The two rows that are known to be needed ───────────────────────────────
-- Left commented on purpose. Uncomment only after confirming that each pair is
-- one person; the note is what makes that confirmation reviewable later.
--
-- insert into finance_division.lo_payroll_aliases (payroll_name, loan_officer, note) values
--   ('BADOVINAC, STEVEN P', 'Steve Badovinac',
--    'Same person: Steve is the short form of Steven. 22 closings, $10.7M; pay sits in Sign-On Bonus and Guarantee.'),
--   ('CASTRO, JULY M', 'Julymar Mar Castro',
--    'Same person. CONFIRM BEFORE USING: the payroll also holds CASTRO, JUSETH M, a different person, and the two are one letter apart in the given name.');
