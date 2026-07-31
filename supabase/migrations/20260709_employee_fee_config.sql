-- ─── Employee Fee Config ─────────────────────────────────────────────────────
-- Marks Roster Offshore employees as "not recoverable to branches".
-- When marked, two synthetic accounting lines (income + cost) are auto-generated
-- per month the employee appears in pl_transactions with source='offshore_allocations'.

CREATE TABLE IF NOT EXISTS employee_fee_config (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  check_description_3  TEXT          NOT NULL UNIQUE,
  not_recoverable      BOOLEAN       NOT NULL DEFAULT false,
  fee_amount           NUMERIC(14,2),
  created_at           TIMESTAMPTZ   DEFAULT now(),
  updated_at           TIMESTAMPTZ   DEFAULT now()
);

-- ─── GL Mapping rows for synthetic Employee Fee accounts ─────────────────────
-- Uses codes 90001/90002 (outside the real GL range) so they never collide with
-- an actual accounting code.  order_1/2/3 = current max + 1/2 so they sort last.
-- The user can reorder these from Settings → GL Mapping at any time.

WITH max_vals AS (
  SELECT
    COALESCE(MAX(order_1), 0) AS mo1,
    COALESCE(MAX(order_2), 0) AS mo2,
    COALESCE(MAX(order_3), 0) AS mo3
  FROM gl_mapping
)
INSERT INTO gl_mapping (gl_code, gl_name, category_2, category_6, category_7, order_1, order_2, order_3)
SELECT code, gname, 'Employee Fee Adjustments', 'Employee Fee Adjustments', gname,
       mo1 + seq, mo2 + seq, mo3 + seq
FROM (
  VALUES
    ('90001', 'Employee Fee Income', 1),
    ('90002', 'Employee Fee Cost',   2)
) AS t(code, gname, seq)
CROSS JOIN max_vals
ON CONFLICT (gl_code) DO NOTHING;
