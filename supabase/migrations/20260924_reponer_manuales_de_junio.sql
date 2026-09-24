-- ─────────────────────────────────────────────────────────────────────────────
-- LAS 33 ASIGNACIONES MANUALES DE JUNIO QUE SE PERDIERON AL BORRAR EL DUPLICADO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- El 2026-09-24 se borraron a mano las 1.300 filas de junio de un archivo que
-- lo duplicaba. Con ellas se fueron 33 asignaciones manuales. El borrado fue
-- por SQL directo, asi que no paso por el flujo de Replace y
-- `manual_assignment_backups` NO las tiene -- solo guarda agosto (182) y
-- septiembre (44).
--
-- Se reponen CASANDO POR FIRMA contra las filas del archivo nuevo:
-- (gl_code, prefijo de check_description, movement) dentro de junio 2026,
-- sucursal 700.
--
-- ⚠ POR PREFIJO Y NO POR IGUALDAD: las descripciones de origen venian
-- truncadas a 30 caracteres. Y la de TRANSLATIONS llevaba un caracter corrupto
-- donde iba una tilde, asi que su prefijo se corta antes.
--
-- ── LO MEDIDO, ANTES DE APLICAR NADA ────────────────────────────────────────
--
--     casan con UNA fila                26
--     no casan                           7
--     casan con VARIAS                   0     <- ninguna ambigua
--
-- Y las 26 que casan NO son todas lo mismo, que es lo que decide que hacer:
--
--     B  casan y estan SIN CECO        14   <- la perdida de verdad
--     C  casan y la regla YA da ese ceco 11   <- fijarlas no cambia el P&L
--     D  casan y la regla da OTRO ceco    1   <- decision de negocio
--
-- ⚠ `assigned_by` SE QUEDA EN NULL. No se sabe quien las hizo, y ponerle un
-- nombre seria inventarlo. La fecha si queda: el trigger
-- `trg_pl_transactions_cc_updated_at` mueve `updated_at` al cambiar la
-- asignacion, asi que constara CUANDO se repusieron -- que es lo cierto.

-- ═════════════════════════════════════════════════════════════════════════════
-- BLOQUE B — LAS 14 QUE ESTAN SIN CECO. Esta es la reposicion de verdad.
-- ═════════════════════════════════════════════════════════════════════════════

WITH objetivo(gl, pref, mov, ceco) AS (VALUES
  ('62210','06/2026 ACCT# 400661',          -772.16,   'CC07-Tenant Homesi : Administration'),
  ('62210','06/12/26 CUST# 001117-00001',   -238.17,   'CC07-Tenant Homesi : Administration'),
  ('60125','INCENTIVES JUNE -DANIELA ESGUE',  59.55,   'CC07-Tenant Homesi : Administration'),
  ('60125','INCENTIVES JUNE - KAREN GERTRU', 138.95,   'CC07-Tenant Homesi : Administration'),
  ('60125','INCENTIVES JUNE - YENNY PAOLA',   79.40,   'CC07-Tenant Homesi : Administration'),
  ('61500','PayPal',                         -11.00,   'CC07-Tenant Homesi : Administration'),
  ('61500','Translation',                    -11.00,   'CC07-Tenant Homesi : Administration'),
  ('61500','TRANSLATIONS JUNE',               45.91,   'CC07-Tenant Homesi : Administration'),
  ('61200','HOMESI June payroll',         -89175.44,   'Eliminations'),
  ('61200','HOMESI Payroll - June',       -89175.44,   'Eliminations'),
  ('64100','LOPEZ-BOGGIO, JOSE A-RECLASS',    73.81,   'Need Reclass'),
  ('60117','LOPEZ-BOGGIO, JOSE A-RECLASS',   510.80,   'Need Reclass'),
  ('64100','LOPEZ-BOGGIO, JOSE A',           -73.81,   'Need Reclass'),
  ('55601','CREDIT EXPENSE RECONCILIATION',  -490.39,  'TBD')
)
UPDATE finance_division.pl_transactions t
   SET cost_center_id     = c.id,
       cost_center_status = 'assigned',
       cost_center_conflicts = NULL,
       conflict_type      = NULL,
       assignment_origin  = 'manual',
       assigned_by        = NULL   -- no se sabe, y no se inventa
  FROM objetivo o
  JOIN finance_division.cost_centers c ON c.name = o.ceco
 WHERE t.source = 'original' AND t.year = 2026 AND t.month = 'June' AND t.branch = '700'
   AND t.gl_code = o.gl
   AND t.check_description LIKE o.pref || '%'
   AND round(t.movement::numeric, 2) = o.mov
   -- ⚠ Solo las que siguen sin ceco: si algo las asigno entre la medicion y
   --   esto, la reposicion no lo pisa en silencio.
   AND t.cost_center_id IS NULL;
-- Debe afectar a 14 filas.

-- ═════════════════════════════════════════════════════════════════════════════
-- BLOQUE C — LAS 11 QUE LA REGLA YA PONE EN SU SITIO.  ⚠ OPCIONAL, Y NO ES
-- INOCUO: no cambia ningun importe, pero las CONGELA. Una asignacion manual
-- es permanente y el Reapply la salta, asi que dejaran de seguir a las reglas
-- para siempre -- incluida cualquier correccion futura del margen.
-- Descomentar solo si se quiere ese blindaje.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WITH objetivo(gl, pref, mov, ceco) AS (VALUES
--   ('41309','733002046963|RODAS MALDONADO |',2880.00,'CC01-Margin Override'),
--   ('41309','733002055638|HOMEBUYER EARNED', 3534.80,'CC01-Margin Override'),
--   ('41309','760002024590|VASQUEZ HUINIL |', 2572.44,'CC01-Margin Override'),
--   ('41309','700002058840|HOMEBUYER EARNED', 1730.57,'CC01-Margin Override'),
--   ('41309','760002050348|CHEVEZ CASTILLO |',2302.52,'CC01-Margin Override'),
--   ('41309','700002054970|HOMEBUYER EARNED', 2938.30,'CC01-Margin Override'),
--   ('41309','770002059650|HOMEBUYER EARNED', 3682.07,'CC01-Margin Override'),
--   ('41309','703002057812|GUTIERREZ QUINONE', 520.00,'CC03-B2B'),
--   ('41309','747002057107|RAMIREZ SANTANA |',2138.17,'CC03-B2B'),
--   ('41309','700002057242|HOMEBUYER EARNED', 2761.48,'CC03-B2B'),
--   ('41307','710002054649|LICERIO | DAFNE',   957.34,'CC04-Recruitment')
-- )
-- UPDATE finance_division.pl_transactions t
--    SET assignment_origin = 'manual', assigned_by = NULL
--   FROM objetivo o
--  WHERE t.source='original' AND t.year=2026 AND t.month='June' AND t.branch='700'
--    AND t.gl_code = o.gl AND t.check_description LIKE o.pref||'%'
--    AND round(t.movement::numeric,2) = o.mov;

-- ═════════════════════════════════════════════════════════════════════════════
-- BLOQUE D — LA UNICA QUE CAMBIARIA DE CECO.  ⚠ NO SE APLICA: ES UNA DECISION
-- DE NEGOCIO, NO UNA REPOSICION.
--
--     41307 · 724002048895|PARRA GONZALEZ · 1.425,00
--     lo manual decia  CC01-Margin Override
--     la regla dice    CC03-B2B
--
-- La regla dice CC03 porque el 2026-09-21 se le añadio la cuenta 41307 -- el
-- cambio que hicimos para que el margen RM de un prestamo B2B dejara de
-- quedarse sin asignar. Asi que reponer lo manual aqui NO es restaurar un
-- estado: es revocar esa regla para esta fila.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Comprobacion, despues del bloque B ──────────────────────────────────────
--
-- select coalesce(c.name,'(sin ceco)') ceco, t.assignment_origin, count(*)
--   from finance_division.pl_transactions t
--   left join finance_division.cost_centers c on c.id=t.cost_center_id
--  where t.source='original' and t.year=2026 and t.month='June' and t.branch='700'
--    and t.assignment_origin='manual'
--  group by 1,2 order by 1;
--   -> 14 filas manuales, repartidas asi:
--
--        CC07-Tenant Homesi : Administration   8   (2x 62210, 3x 60125, 3x 61500)
--        Need Reclass                          3   (2x 64100, 1x 60117)
--        Eliminations                          2   (2x 61200)
--        TBD                                   1   (1x 55601)
--                                            ───
--                                             14
