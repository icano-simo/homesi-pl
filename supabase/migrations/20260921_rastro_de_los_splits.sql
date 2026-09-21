-- ─────────────────────────────────────────────────────────────────────────────
-- QUIEN CREO LA REGLA DE REPARTO, Y CUANDO SE TOCO POR ULTIMA VEZ
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `cc_allocation_splits` tiene `created_at` y nada mas: ni autor, ni fecha de
-- modificacion.
--
-- ⚠ LO QUE COSTO NO TENERLO, el 2026-09-21. Una regla con
-- `assign_value = 'Default'` al 100% hacia CC03-B2B reasignaba en pantalla
-- **1.212.355,83 en 740 filas y 14 cuentas**: "Default" no es un proveedor,
-- es el relleno mas comun del archivo, asi que la regla funcionaba de comodin.
-- Movia 198.923,84 de CC01, CC04 y Direct cost normalization a CC03 sin que
-- nada fallara -- el total de la pantalla seguia cuadrando, porque el dinero
-- no se duplicaba: se mudaba.
--
-- Se pudo ver QUE hizo y CUANDO se creo --19:25:44 de ese mismo dia-- pero no
-- QUIEN. Una regla que mueve un millon y pico no puede ser anonima.
--
-- ⚠ `updated_at` NO ES REDUNDANTE CON `created_at`. El evaluador ya compara la
-- fecha de una regla contra `conflict_snapshots.resolved_at` para decidir si
-- reabre un conflicto resuelto a mano --ver la guarda en
-- app/api/cost-centers/reapply/route.ts--. Hoy esa comparacion se hace contra
-- `split_rules.updated_at`, que es OTRA tabla: las reglas de reparto por
-- proveedor no tienen con que compararse.
--
-- ⚠ NO SE RELLENA EL AUTOR DE LAS 4.186 EXISTENTES. No se sabe, y ponerle un
-- valor seria afirmarlo. `updated_at` si se puede inicializar a `created_at`,
-- porque eso no inventa nada: una regla que nunca se ha tocado se modifico por
-- ultima vez cuando se creo.

ALTER TABLE finance_division.cc_allocation_splits
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE finance_division.cc_allocation_splits
   SET updated_at = created_at
 WHERE updated_at IS NULL;

ALTER TABLE finance_division.cc_allocation_splits
  ALTER COLUMN updated_at SET DEFAULT now();

COMMENT ON COLUMN finance_division.cc_allocation_splits.created_by IS
  'Email de quien creo la regla, de la sesion del servidor y nunca del cuerpo '
  'de la peticion -- el mismo patron que pl_notes.author. NULL en las 4.186 '
  'anteriores al 2026-09-21: no se sabe, y rellenarlo seria inventarlo.';

COMMENT ON COLUMN finance_division.cc_allocation_splits.updated_at IS
  'Ultima modificacion. Inicializada a created_at en las existentes, que no '
  'inventa nada: una regla sin tocar se modifico cuando se creo. Sirve para la '
  'misma comparacion contra conflict_snapshots.resolved_at que ya hace '
  'split_rules.updated_at.';

-- Mantiene `updated_at` sin depender de que cada ruta se acuerde de ponerla.
-- Es exactamente el fallo que este rastro existe para evitar.
CREATE OR REPLACE FUNCTION finance_division.tocar_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cc_allocation_splits_updated_at
  ON finance_division.cc_allocation_splits;

CREATE TRIGGER cc_allocation_splits_updated_at
  BEFORE UPDATE ON finance_division.cc_allocation_splits
  FOR EACH ROW EXECUTE FUNCTION finance_division.tocar_updated_at();
