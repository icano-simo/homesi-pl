-- ─────────────────────────────────────────────────────────────────────────────
-- QUIEN CREO LA REGLA DE REPARTO, Y CUANDO SE TOCO POR ULTIMA VEZ
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `cc_allocation_splits` tiene `created_at` y nada mas: ni autor, ni fecha de
-- modificacion. Comprobado en la tabla antes de escribir esto.
--
-- ⚠ LO QUE COSTO NO TENERLO, el 2026-09-21. Una regla con
-- `assign_value = 'Default'` al 100% hacia CC03-B2B reasignaba en pantalla
-- **1.212.355,83 en 740 filas y 14 cuentas**: "Default" no es un proveedor, es
-- el relleno mas comun del archivo, asi que la regla funcionaba de comodin.
-- Movia 198.923,84 de CC01, CC04 y Direct cost normalization a CC03 sin que
-- nada fallara -- el total seguia cuadrando, porque el dinero no se duplicaba:
-- se mudaba. Se supo QUE hizo y CUANDO se creo --19:25:44 de ese dia-- pero no
-- QUIEN. Una regla que mueve un millon y pico no puede ser anonima.
--
-- ⚠ `updated_at` NO ES REDUNDANTE AQUI, y en `pl_transactions` SI lo era. Esa
-- tabla ya tiene un trigger que mueve `updated_at` solo al cambiar la
-- asignacion, asi que alli sobraba una columna nueva. Esta tabla no tiene
-- ninguno de los dos. Son dos tablas distintas y la respuesta es distinta en
-- cada una: por eso se mira antes en vez de repetir la misma migracion.
--
-- El evaluador ya compara la fecha de una regla contra
-- `conflict_snapshots.resolved_at` para decidir si reabre un conflicto
-- resuelto a mano --la guarda de app/api/cost-centers/reapply/route.ts-- pero
-- lo hace contra `split_rules.updated_at`, que es OTRA tabla: las reglas de
-- reparto por proveedor no tienen con que compararse.
--
-- ⚠ SE REUSA `finance_division.update_updated_at()`, QUE YA EXISTE. Mi primera
-- version creaba una funcion nueva --`tocar_updated_at`-- haciendo exactamente
-- lo mismo que una que ya estaba en el esquema. Dos funciones identicas con
-- nombres distintos es como una de las dos se queda sin arreglar el dia que
-- haga falta tocarlas.
--
-- ⚠ NO SE RELLENA EL AUTOR DE LAS 4.186 EXISTENTES. No se sabe. `updated_at`
-- si se inicializa a `created_at`, porque eso no inventa nada: una regla que
-- nunca se ha tocado se modifico por ultima vez cuando se creo.

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
  'Ultima modificacion, mantenida por trigger. Inicializada a created_at en '
  'las existentes, que no inventa nada: una regla sin tocar se modifico cuando '
  'se creo. Sirve para la misma comparacion contra conflict_snapshots.'
  'resolved_at que ya hace split_rules.updated_at.';

-- La funcion ya existe en el esquema; aqui solo se engancha.
DROP TRIGGER IF EXISTS cc_allocation_splits_updated_at
  ON finance_division.cc_allocation_splits;

CREATE TRIGGER cc_allocation_splits_updated_at
  BEFORE UPDATE ON finance_division.cc_allocation_splits
  FOR EACH ROW EXECUTE FUNCTION finance_division.update_updated_at();

-- ── Comprobacion ────────────────────────────────────────────────────────────
--
-- select count(*) filter (where updated_at is null) sin_fecha,
--        count(*) filter (where updated_at = created_at) igual_a_created,
--        count(*) total
--   from finance_division.cc_allocation_splits;
--   -> sin_fecha 0, y igual_a_created = total mientras nadie las haya tocado.
--
-- select trigger_name from information_schema.triggers
--  where event_object_schema='finance_division'
--    and event_object_table='cc_allocation_splits';
--   -> cc_allocation_splits_updated_at
