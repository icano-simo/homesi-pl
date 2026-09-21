-- ─────────────────────────────────────────────────────────────────────────────
-- QUIEN ASIGNO A MANO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `pl_transactions.assignment_origin = 'manual'` es PERMANENTE: el Reapply la
-- salta antes de evaluar nada. Es una decision que gana a todas las reglas para
-- siempre, y hoy no consta quien la tomo.
--
-- ⚠ LO QUE COSTO NO TENERLO, el 2026-09-21. Veinticuatro filas de 41309 en la
-- 700, 42.591,70, de prestamos que SI son B2B, estaban asignadas a mano a
-- CC01-Margin Override. Al encontrarlas no habia forma de saber si fueron un
-- error o una decision deliberada tomada cuando la clasificacion del prestamo
-- era otra.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠ NO SE AÑADE `assigned_at`, Y LA PRIMERA VERSION DE ESTE ARCHIVO SI LO HACIA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Esa version decia "updated_at no sirve, lo toca cualquier escritura". ES
-- FALSO, y bastaba mirar la tabla antes de escribirlo. Ya existe el trigger
-- `trg_pl_transactions_cc_updated_at`, BEFORE UPDATE, que hace exactamente:
--
--     IF NEW.cost_center_id     IS DISTINCT FROM OLD.cost_center_id     OR
--        NEW.cost_center_status IS DISTINCT FROM OLD.cost_center_status OR
--        NEW.assignment_origin  IS DISTINCT FROM OLD.assignment_origin
--     THEN NEW.updated_at := NOW(); END IF;
--
-- O sea que `updated_at` NO se mueve con cualquier escritura: se mueve SOLO
-- cuando cambia la asignacion. Ya es la fecha que hacia falta.
--
-- Añadir `assigned_at` habria creado una segunda columna para el mismo hecho,
-- mantenida por otro sitio, y el dia que las dos no coincidieran nadie sabria
-- cual creer. Se añade UNA columna: la que de verdad falta.
--
-- ⚠ Y NO SE RELLENA EL AUTOR DE LAS EXISTENTES. No se sabe, e inventar un
-- "system" o el primer usuario convertiria "no consta" en una afirmacion.

ALTER TABLE finance_division.pl_transactions
  ADD COLUMN IF NOT EXISTS assigned_by TEXT;

COMMENT ON COLUMN finance_division.pl_transactions.assigned_by IS
  'Email de quien asigno el centro de coste A MANO, de la sesion del servidor '
  'y nunca del cuerpo de la peticion -- el mismo patron que pl_notes.author. '
  'NULL en las 2.366 filas manuales anteriores al 2026-09-21: no se sabe, y '
  'rellenarlo seria inventarlo. La FECHA no vive aqui sino en updated_at, que '
  'el trigger trg_pl_transactions_cc_updated_at mueve solo cuando cambia la '
  'asignacion.';

-- ── Comprobacion ────────────────────────────────────────────────────────────
--
-- select column_name from information_schema.columns
--  where table_schema='finance_division' and table_name='pl_transactions'
--    and column_name in ('assigned_by','assigned_at');
--   -> debe salir assigned_by, y NO debe salir assigned_at.
--
-- No se crea ningun indice: la pantalla de "Manual vs rule" no filtra por
-- autor ni por fecha, recorre las 2.366 manuales enteras. Un indice aqui seria
-- por si acaso, y este esquema ya tiene cuatro.
