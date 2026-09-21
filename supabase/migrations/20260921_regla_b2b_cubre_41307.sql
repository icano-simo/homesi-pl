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
-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠ EL PARENTESIS SE ESCRIBE, NO SE DEDUCE DEL ORDEN
-- ═════════════════════════════════════════════════════════════════════════════
--
-- La primera version de este archivo NO ponia `opens_group` / `closes_group`.
-- Se apoyaba en que `evaluateConditions` pliega de izquierda a derecha, asi
-- que `41309 OR 41307 AND b2b=yes` saldria como `(41309 OR 41307) AND b2b=yes`.
--
-- Eso es cierto HOY y es la forma equivocada de escribirlo. La tabla tiene dos
-- columnas para el parentesis y la regla hermana --"Income: Override margin"--
-- las usa: abre en el 41309 y cierra en el 41307. Dejar el agrupamiento a
-- merced de como pliegue el evaluador es exactamente el riesgo que la propia
-- nota advertia, con la solucion delante y sin usarla.
--
-- Sin el parentesis explicito, el dia que alguien reordene las condiciones o
-- cambie el plegado, esto pasa a ser `41309 OR (41307 AND b2b=yes)` y manda a
-- CC03 TODO el 41309 de la division. Con las dos columnas puestas, no.
--
-- ⚠ LAS DOS REGLAS TIENEN QUE MANTENER LA MISMA FORMA. Si una cambia de
-- cuentas, la otra tambien -- son las dos caras de la misma particion:
-- b2b=yes va a CC03 y b2b=no va a CC01, sobre el MISMO par de cuentas.

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

  -- 3. La primera ABRE el parentesis.
  UPDATE finance_division.split_rule_conditions
     SET sequence = 1, logic_connector = NULL,
         opens_group = true, closes_group = false
   WHERE split_rule_id = v_rule AND field = 'gl_code' AND value = '41309';

  -- 4. La cuenta que faltaba, en medio, con OR, y CIERRA el parentesis.
  INSERT INTO finance_division.split_rule_conditions
    (split_rule_id, sequence, logic_connector, field, operator, value,
     group_number, opens_group, closes_group)
  SELECT v_rule, 2, 'OR', 'gl_code', 'equals', '41307', 0, false, true
   WHERE NOT EXISTS (
     SELECT 1 FROM finance_division.split_rule_conditions
      WHERE split_rule_id = v_rule AND field = 'gl_code' AND value = '41307');
END $$;

-- ── Comprobacion: deberia dar exactamente estas tres filas ──────────────────
--
--     seq  connector  field    operator  value   opens  closes
--     1    (null)     gl_code  contains  41309   true   false
--     2    OR         gl_code  equals    41307   false  true
--     3    AND        b2b      equals    yes     false  false
--
-- (el `contains` del 41309 se conserva como estaba; la regla de CC01 usa
--  `equals` para lo mismo y esa asimetria sigue ahi, sin consecuencia hoy
--  porque no existe ningun gl_code que contenga 41309 sin serlo)
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
