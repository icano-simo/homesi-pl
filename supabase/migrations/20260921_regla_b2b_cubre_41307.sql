-- ─────────────────────────────────────────────────────────────────────────────
-- LA REGLA DE B2B SE QUEDABA CORTA EN LA CUENTA, NO EN LA SUCURSAL
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Las dos reglas de margen no eran simetricas:
--
--     Income: Override margin        (41309 OR 41307) AND recruitment=no AND b2b=no  -> CC01
--     B2B income: Override margin     41309 AND b2b=yes AND branch=700               -> CC03
--
-- La de CC01 cubre DOS cuentas y la de B2B solo una. Asi que el margen `41307`
-- de un prestamo B2B no casa con ninguna --la de CC01 exige `b2b = no`-- y se
-- queda SIN ASIGNAR. Por eso alguien tuvo que poner cuatro filas a mano.
--
-- ── LO MEDIDO, 2026-09-21 ───────────────────────────────────────────────────
--
--     41307 de prestamos B2B     23 filas     8.867,16
--        de ellas, sin ceco      11                      <- se asignaran a CC03
--        ya en CC03               9                      <- pasan a estarlo por regla
--        manuales en CC01         3                      <- NO se mueven: manual gana
--
--     41309 de prestamos B2B fuera de la 700      0 filas
--
-- ⚠ POR ESO `branch = 700` SE QUITA AHORA Y NO DESPUES. Hoy no excluye NADA
-- --cero filas-- asi que quitarla no mueve ni un numero, y se puede comprobar
-- que no lo mueve. El dia que exista un 41309 B2B en otra sucursal, esa
-- condicion lo dejaria fuera en silencio y nadie lo veria: el sintoma seria un
-- ceco con menos margen del que le toca, que es exactamente lo que costo tres
-- rondas encontrar esta semana. La regla de CC01 nunca tuvo condicion de
-- sucursal.
--
-- ⚠ Y `contains` PASA A `equals`. `gl_code contains '41309'` casaria tambien
-- con '413090' o 'X41309'. Hoy no hay ninguna, pero la regla de CC01 usa
-- `equals` para lo mismo y dos reglas hermanas que comparan distinto son una
-- diferencia que alguien acabara tomando por intencional.
--
-- ⚠ EL ORDEN DE LAS CONDICIONES ES LA SEMANTICA. El evaluador pliega de
-- IZQUIERDA A DERECHA sin precedencia --ver `evaluateConditions` en
-- lib/evaluate-cost-center-rules.ts-- asi que
-- `41309 OR 41307 AND b2b=yes` se agrupa como `(41309 OR 41307) AND b2b=yes`,
-- que es lo que se quiere y es como ya funciona la regla de CC01. Invertir el
-- orden daria `41309 OR (41307 AND b2b=yes)` y mandaria a CC03 todo el 41309
-- de la division.

DO $$
DECLARE
  v_rule uuid;
BEGIN
  SELECT id INTO v_rule
    FROM finance_division.split_rules
   WHERE name = 'B2B income: Override margin only';

  IF v_rule IS NULL THEN
    RAISE EXCEPTION 'No existe la regla "B2B income: Override margin only"';
  END IF;

  -- 1. Fuera la condicion de sucursal.
  DELETE FROM finance_division.split_rule_conditions
   WHERE split_rule_id = v_rule AND field = 'branch';

  -- 2. El b2b baja a la tercera posicion, para dejar hueco al 41307.
  UPDATE finance_division.split_rule_conditions
     SET sequence = 3, logic_connector = 'AND'
   WHERE split_rule_id = v_rule AND field = 'b2b';

  -- 3. La primera condicion compara igual que la de CC01.
  UPDATE finance_division.split_rule_conditions
     SET operator = 'equals', sequence = 1, logic_connector = NULL
   WHERE split_rule_id = v_rule AND field = 'gl_code' AND value = '41309';

  -- 4. La cuenta que faltaba, en medio y con OR.
  INSERT INTO finance_division.split_rule_conditions
    (split_rule_id, sequence, logic_connector, field, operator, value, group_number)
  SELECT v_rule, 2, 'OR', 'gl_code', 'equals', '41307', 0
   WHERE NOT EXISTS (
     SELECT 1 FROM finance_division.split_rule_conditions
      WHERE split_rule_id = v_rule AND field = 'gl_code' AND value = '41307');
END $$;

-- ── Comprobacion: deberia dar exactamente estas tres filas ──────────────────
--
--     sequence  connector  field    operator  value
--     1         (null)     gl_code  equals    41309
--     2         OR         gl_code  equals    41307
--     3         AND        b2b      equals    yes
--
-- select c.sequence, c.logic_connector, c.field, c.operator, c.value
--   from finance_division.split_rule_conditions c
--   join finance_division.split_rules r on r.id = c.split_rule_id
--  where r.name = 'B2B income: Override margin only'
--  order by c.sequence;
--
-- ⚠ EL CAMBIO NO SE APLICA SOLO. Las reglas se evaluan al ESCRIBIR, asi que
-- las 11 filas sin ceco siguen sin el hasta que se pulse Reapply. Y Reapply
-- sin sucursales marcadas usa `app_settings.active_branches`, que vale `710`:
-- hay que marcar las sucursales a mano o no pasara por ninguna de estas.
