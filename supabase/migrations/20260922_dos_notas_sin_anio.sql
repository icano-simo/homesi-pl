-- ─────────────────────────────────────────────────────────────────────────────
-- LAS DOS NOTAS QUE SE ANCLABAN A TODOS LOS AÑOS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- El eje de la rejilla son NOMBRES de mes, asi que una nota con `month` y sin
-- `year` sale en julio de 2025 Y en julio de 2026. Estas dos se escribieron
-- con dos años cargados a la vez, que es cuando `scopeYear` vale `undefined`
-- y `reportBaseScope` omite el año:
--
--     61200 · July   · 700 · "VICSA Consulting Group Recon"
--     61200 · August · 700 · "HOMESI payroll WIRE"     <- 2026-09-22, kelly.ovalle
--
-- EL AÑO LO DECIDE EL USUARIO, NO EL CODIGO. Confirmado: las dos son de 2026.
-- No se dedujo de la fecha de creacion ni del mes: una nota escrita en
-- septiembre puede hablar de julio del año anterior, y adivinarlo habria
-- dejado un dato inventado con aspecto de decidido.
--
-- ⚠ HAY QUE REESCRIBIR `scope_key` TAMBIEN, Y NO ES UN DETALLE. Es la clave
-- canonica que decide si una nota es "de esta celda" --`isDirectNote` compara
-- `note.scope_key` con `canonicalScopeKey(cellScope)`-- asi que cambiar solo
-- `scope` dejaria la nota en el sitio nuevo para la contencion y en el viejo
-- para la comparacion directa. El formato lo genera `canonicalScopeKey`:
-- pares `clave=valor` con el valor URL-encoded, ordenados alfabeticamente por
-- clave y unidos por `|`. `year` va el ultimo por orden alfabetico.
--
-- El fallo que las creo ya no puede repetirse: la ruta rechaza una nota con
-- mes y sin año, y la pantalla avisa cuando hay dos años cargados. Ver el PR
-- "Un mes sin año se ancla a todos los años".

UPDATE finance_division.pl_notes
   SET scope     = scope || '{"year": 2026}'::jsonb,
       scope_key = scope_key || '|year=2026'
 WHERE level = 'description'
   AND NOT (scope ? 'year')
   AND scope->>'month' IN ('July', 'August')
   AND scope->>'branch' = '700'
   AND scope->>'gl' = '61200';

-- ── Comprobacion ────────────────────────────────────────────────────────────
--
-- Deberia devolver 0 filas: ninguna nota del pivot con mes y sin año.
--
-- select id, level, scope, scope_key from finance_division.pl_notes
--  where (scope ? 'month') and not (scope ? 'year');
--
-- Y las dos, con su clave rehecha:
--
-- select scope->>'month' mes, scope->>'year' anio, scope_key
--   from finance_division.pl_notes
--  where scope->>'gl' = '61200' and scope->>'branch' = '700'
--    and scope->>'description' in ('VICSA Consulting Group Recon',
--                                  'HOMESI payroll WIRE');
--
-- ⚠ COMPROBAR QUE `scope_key` TERMINA EN `|year=2026` y que el resto de la
-- clave no cambio. Si alguna de las dos tuviera ya otra clave despues de
-- `year` alfabeticamente, esta concatenacion la dejaria desordenada -- hoy no
-- la hay, porque `year` es la ultima de las claves que usan estas notas.
