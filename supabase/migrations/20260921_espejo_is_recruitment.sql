-- ─────────────────────────────────────────────────────────────────────────────
-- `is_recruitment` EN EL ESPEJO, COMO `is_b2b`
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `activity_report.loan_records_v2` tiene `is_affinity`, `is_b2b`, `is_closed`
-- y `is_second_lien_heloc`. NO tiene `is_recruitment`, y por eso la
-- clasificacion de recruitment era el ULTIMO campo que seguia saliendo de
-- `finance_division.loan_officials` -- la tabla que se sube a mano y lleva
-- parada desde el 2026-08-20.
--
-- ⚠ NO HAY QUE TOCAR BIGQUERY. `fct_commercial_activity` tampoco tiene
-- `is_b2b`: el sync lo DERIVA de `strategy`, y la misma puerta sirve para
-- este. La forma exacta que ya usa, en simo-sync app/api/sync/route.ts:
--
--     // La vista no expone is_b2b: se deriva de la estrategia, que ya resuelve
--     // la precedencia Affinity > NPPM > Recruitment > B2B > Own Production.
--     "strategy = 'B2B' AS is_b2b",
--
-- Se copia tal cual, cambiando el valor. `strategy` viene lleno en las 5.114
-- filas del espejo.
--
-- ── LO MEDIDO, 2026-09-21 ───────────────────────────────────────────────────
--
--     strategy         Own Production 316 · B2B 105 · Affinity 39 ·
--                      Recruitment 22 · NPPM 21   (sobre los cierres)
--     en todo el espejo, strategy = 'Recruitment'      299 filas
--
-- ⚠ Y `is_b2b` ES EXACTAMENTE `strategy = 'B2B'`, comprobado en los dos
-- sentidos: 800 filas con `is_b2b`, 800 con `strategy = 'B2B'`, CERO que
-- tengan una cosa y no la otra. Por eso se puede copiar la forma sin dudar de
-- que signifique otra cosa.
--
-- ⚠ `strategy` ES UN VALOR UNICO, NO UN CONJUNTO, y eso CAMBIA una semantica.
-- `loan_officials` tenia `b2b` y `recruitment` como banderas independientes, y
-- un prestamo podia llevar las dos. Con `strategy` no: la precedencia elige
-- una. Medido, hay UN caso -- 747002052489, que `loan_officials` marca
-- recruitment y el espejo llama `B2B`. De las 18 marcadas recruitment, 17
-- casan por strategy y esa no.
--
-- No es una perdida: es que las dos fuentes no dicen lo mismo, y la del espejo
-- tiene una regla de precedencia escrita mientras la otra son dos casillas que
-- alguien marco. Ademas resuelve solo el unico conflicto que quedaba vivo, el
-- de un prestamo que casaba con la regla de B2B y con la de Recruitment a la
-- vez.

ALTER TABLE activity_report.loan_records_v2
  ADD COLUMN IF NOT EXISTS is_recruitment BOOLEAN;

COMMENT ON COLUMN activity_report.loan_records_v2.is_recruitment IS
  'Derivada por simo-sync como strategy = ''Recruitment'', exactamente igual '
  'que is_b2b se deriva de strategy = ''B2B''. BigQuery no la expone. '
  'strategy resuelve la precedencia Affinity > NPPM > Recruitment > B2B > '
  'Own Production, asi que es EXCLUYENTE con is_b2b: un prestamo no puede ser '
  'las dos cosas, a diferencia de las banderas sueltas de loan_officials.';

-- ⚠ SE QUEDA EN NULL HASTA QUE EL SYNC PASE. Nada la rellena desde aqui: un
-- UPDATE ... SET is_recruitment = (strategy = 'Recruitment') dejaria un valor
-- calculado en Supabase que el siguiente sync podria pisar con otra regla, y
-- entonces habria dos sitios derivandola. La deriva el sync o no la deriva
-- nadie.
--
-- Mientras tanto la app lee `strategy = 'Recruitment'` como respaldo, que es
-- el MISMO predicado y no una segunda definicion. Ver la nota en
-- lib/reevaluate-rule-assigned.ts.

-- ── Comprobacion, despues del primer sync ───────────────────────────────────
--
-- select count(*) filter (where is_recruitment) por_la_columna,
--        count(*) filter (where strategy = 'Recruitment') por_la_estrategia,
--        count(*) filter (where is_recruitment is null) sin_rellenar
--   from activity_report.loan_records_v2;
--   -> las dos primeras iguales, la tercera 0.
