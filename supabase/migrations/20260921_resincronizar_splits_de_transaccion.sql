-- ─────────────────────────────────────────────────────────────────────────────
-- LA REJILLA SIGUE AL SPLIT, NO A LA COLUMNA
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `pl_transactions.cost_center_id` NO es lo que pinta el P&L cuando hay un
-- filtro de centro de coste. El pivot llama antes a `fanOutBySplits`, que
-- SOBRESCRIBE el ceco de la fila con el de su split:
--
--     cost_center_id:     s.cost_center_id,      // lib/apply-splits.ts
--     cost_center_status: "assigned",
--
-- Y un `assign_type = 'transaction'` apunta a UNA fila concreta por su id. Asi
-- que cambiar `cost_center_id` con un UPDATE directo no mueve nada en
-- pantalla: el split sigue diciendo el ceco viejo y gana.
--
-- ── EL CASO, 2026-09-21 ─────────────────────────────────────────────────────
--
-- Se movieron 24 filas de CC01-Margin Override a CC03-B2B --41309 de la 700,
-- de prestamos B2B, asignadas a mano-- con un UPDATE que solo tocaba
-- `cost_center_id`. En la base quedaron en CC03. En la pantalla, en CC01.
--
-- Medido con los filtros del usuario (Year 2026 · Branch 700), CC03 · Revenue:
--
--     ene 19.995,15 · feb 6.507,40 · mar 15.269,91 · abr 26.140,32
--     may 15.268,51 · jun 26.565,07 · jul 28.470,03 · ago 0,00 · sep 0,00
--     ------------------------------------------------------------------
--     total 138.216,39 en 82 filas
--
-- Que es EXACTAMENTE el total de antes del UPDATE. Agosto y septiembre salen a
-- cero porque el revenue que CC03 tenia en esos dos meses eran justo esas
-- filas, y el abanico las devuelve a CC01. El dato existe --165.625,63 en 98
-- filas-- y la pantalla ensena 138.216,39.
--
-- ⚠ NO ES UN DESAJUSTE GENERALIZADO, Y LA PRIMERA MEDICION LO PARECIA.
-- Contando "el ceco del split difiere del de la fila" salen 1.394, pero eso
-- incluye los repartos legitimos: en un 60/40 la fila solo puede coincidir con
-- uno de los dos. Mirando solo los splits de UNA linea al 100% --1.883 de
-- 2.564-- las desincronizadas son VEINTICUATRO, las 24 de ese UPDATE, por
-- 42.591,70. Ninguna otra fila de la base esta asi.
--
-- ⚠ LA GUARDA DEL 100% Y DE LA LINEA UNICA ES LO QUE HACE ESTO SEGURO. Sin
-- ella, este UPDATE machacaria los repartos de verdad y mandaria el 100% de un
-- 60/40 a un solo centro.

-- ── Antes: deberia devolver 24 ──────────────────────────────────────────────
-- select count(*) from finance_division.cc_allocation_splits s
--   join finance_division.pl_transactions t on t.id::text = s.assign_value
--  where s.assign_type = 'transaction' and s.percentage = 100
--    and t.cost_center_id is not null and s.cost_center_id <> t.cost_center_id
--    and (select count(*) from finance_division.cc_allocation_splits x
--          where x.assign_type = 'transaction' and x.assign_value = s.assign_value) = 1;

UPDATE finance_division.cc_allocation_splits s
   SET cost_center_id = t.cost_center_id
  FROM finance_division.pl_transactions t
 WHERE s.assign_type = 'transaction'
   AND t.id::text = s.assign_value
   AND t.cost_center_id IS NOT NULL
   AND s.cost_center_id <> t.cost_center_id
   -- Solo los de destino unico: ver la nota de arriba.
   AND s.percentage = 100
   AND (SELECT count(*) FROM finance_division.cc_allocation_splits x
         WHERE x.assign_type = 'transaction' AND x.assign_value = s.assign_value) = 1;

-- ── Despues: las tres deberian dar 0, 165625.63 y 98 ────────────────────────
-- select count(*) from finance_division.cc_allocation_splits s
--   join finance_division.pl_transactions t on t.id::text = s.assign_value
--  where s.assign_type = 'transaction' and s.percentage = 100
--    and t.cost_center_id is not null and s.cost_center_id <> t.cost_center_id
--    and (select count(*) from finance_division.cc_allocation_splits x
--          where x.assign_type = 'transaction' and x.assign_value = s.assign_value) = 1;
--
-- select round(sum(movement)::numeric,2), count(*)
--   from finance_division.pl_transactions
--  where year = 2026 and branch = '700' and gl_code = '41309'
--    and cost_center_id = 'ece732dd-7cf1-4494-86df-49c65f712f92';
