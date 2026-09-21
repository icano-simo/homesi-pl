-- ─────────────────────────────────────────────────────────────────────────────
-- QUIEN ASIGNO A MANO, Y CUANDO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `pl_transactions.assignment_origin = 'manual'` es PERMANENTE: el Reapply la
-- salta antes de evaluar nada. Es una decision que gana a todas las reglas para
-- siempre, y hoy no consta quien la tomo ni cuando.
--
-- ⚠ LO QUE COSTO NO TENERLO, medido el 2026-09-21. Veinticuatro filas de
-- 41309 en la 700, 42.591,70, de prestamos que SI son B2B, estaban asignadas a
-- mano a CC01-Margin Override. Al encontrarlas no habia forma de saber si
-- fueron un error o una decision deliberada tomada cuando la clasificacion del
-- prestamo era otra. Se pudo medir que 1.983 filas manuales difieren de lo que
-- dirian las reglas hoy, pero NO cual de esas diferencias es un olvido y cual
-- una decision -- solo 31 de 2.366 tenian una fecha con la que comparar.
--
-- `updated_at` no sirve para esto: lo toca cualquier escritura sobre la fila,
-- asi que dice cuando se modifico algo, no cuando se asigno el centro de coste.
--
-- ⚠ NO SE RELLENAN LAS FILAS EXISTENTES, y es deliberado. Inventar un autor
-- --"system", el primer usuario, el de la ultima sesion-- convertiria "no se
-- sabe" en una afirmacion falsa, que es el error que este repo lleva toda la
-- sesion evitando. Las 2.366 manuales de hoy se quedan con NULL, que es lo
-- unico cierto sobre ellas, y la pantalla lo dira asi.

ALTER TABLE finance_division.pl_transactions
  ADD COLUMN IF NOT EXISTS assigned_by TEXT,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

COMMENT ON COLUMN finance_division.pl_transactions.assigned_by IS
  'Email de quien asigno el centro de coste A MANO, de la sesion del servidor '
  'y nunca del cuerpo de la peticion -- el mismo patron que pl_notes.author. '
  'NULL en las 2.366 filas manuales anteriores al 2026-09-21: no se sabe, y '
  'rellenarlo seria inventarlo. Solo se escribe cuando assignment_origin es '
  '''manual''; las asignaciones por regla no tienen autor humano.';

COMMENT ON COLUMN finance_division.pl_transactions.assigned_at IS
  'Cuando se asigno el centro de coste a mano. NO es updated_at, que lo toca '
  'cualquier escritura: esta solo se mueve cuando cambia la asignacion. Sirve '
  'para distinguir una decision deliberada de una clasificacion que cambio '
  'despues -- comparandola con loan_manual_flags.set_at o con la fecha de la '
  'regla.';

-- Solo se consulta al listar los desacuerdos, que son decenas de filas sobre
-- 17.238. Un indice parcial sobre las manuales cuesta poco y evita el scan.
CREATE INDEX IF NOT EXISTS pl_transactions_manual_assign_idx
  ON finance_division.pl_transactions (assigned_at)
  WHERE assignment_origin = 'manual';
