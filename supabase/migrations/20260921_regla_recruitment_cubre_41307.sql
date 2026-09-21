-- ─────────────────────────────────────────────────────────────────────────────
-- LA TERCERA REGLA HERMANA, QUE SE QUEDO ATRAS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Gemelo de `20260921_regla_b2b_cubre_41307.sql`. Aplicado a mano el
-- 2026-09-21; este archivo existe para que quede el registro de que se hizo y
-- por que.
--
-- Son TRES reglas que parten el mismo margen en tres destinos:
--
--     Income: Override margin     (41309 OR 41307) AND recruitment=no AND b2b=no  -> CC01
--     B2B income                  (41309 OR 41307) AND b2b=yes                    -> CC03
--     Recruitment income          (41309 OR 41307) AND recruitment=yes            -> CC04
--
-- Hasta hoy la de Recruitment miraba SOLO `41309`, sin parentesis, asi que el
-- margen `41307` de un prestamo de recruitment no casaba con ninguna de las
-- tres --la de CC01 exige `recruitment = no`-- y se quedaba sin asignar.
--
-- Medido: 2 filas, 2.130,70. Poco dinero, y no es el motivo.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠ EL MOTIVO ES QUE LAS TRES TENGAN LA MISMA FORMA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Una de tres hermanas escrita distinta es por donde se cuela la siguiente
-- asimetria: quien mire las otras dos dara por hecho que la tercera hace lo
-- mismo. Si mañana entra una cuenta nueva al margen, tiene que entrar en las
-- tres a la vez, y eso solo se ve si las tres se leen igual.
--
-- ⚠ Y ESTO ES EL PATRON DE docs/un-fallo-arreglado-vuelve-por-el-siguiente-
-- camino.md EN SU VERSION MAS SIMPLE. Se arreglo la de B2B --que era la que
-- alguien vio fallar-- y las otras dos quedaron con la forma vieja. La de
-- Recruitment no se vio hasta que se pregunto por ella expresamente.
--
-- El barrido, ahora si, esta completo y medido: NINGUNA otra regla de
-- `cost_center_rules` ni de `split_rule_conditions` usa `b2b`, `recruitment`,
-- `processing`, `support_on_demand`, `affinity`, `lead_source_lo` ni
-- `bd_owner`. Son exactamente estas tres.
--
-- ⚠ EL PARENTESIS SE ESCRIBE, NO SE DEDUCE DEL ORDEN. `evaluateConditions`
-- pliega de izquierda a derecha, asi que sin `opens_group`/`closes_group` esto
-- seria `41309 OR (41307 AND recruitment=yes)` en cuanto alguien reordenara
-- las condiciones -- y mandaria a CC04 TODO el 41309 de la division.

DO $$
DECLARE
  v_rule uuid;
BEGIN
  SELECT id INTO v_rule
    FROM finance_division.split_rules
   WHERE name = 'Recruitment income:  override margin';   -- ojo al doble espacio

  IF v_rule IS NULL THEN
    RAISE EXCEPTION 'No existe la regla "Recruitment income:  override margin"';
  END IF;

  -- 1. El recruitment baja a la tercera posicion, para dejar hueco al 41307.
  UPDATE finance_division.split_rule_conditions
     SET sequence = 3, logic_connector = 'AND',
         opens_group = false, closes_group = false
   WHERE split_rule_id = v_rule AND field = 'recruitment';

  -- 2. La primera ABRE el parentesis.
  UPDATE finance_division.split_rule_conditions
     SET sequence = 1, logic_connector = NULL,
         opens_group = true, closes_group = false
   WHERE split_rule_id = v_rule AND field = 'gl_code' AND value = '41309';

  -- 3. La cuenta que faltaba, en medio, con OR, y CIERRA el parentesis.
  INSERT INTO finance_division.split_rule_conditions
    (split_rule_id, sequence, logic_connector, field, operator, value,
     group_number, opens_group, closes_group)
  SELECT v_rule, 2, 'OR', 'gl_code', 'equals', '41307', 0, false, true
   WHERE NOT EXISTS (
     SELECT 1 FROM finance_division.split_rule_conditions
      WHERE split_rule_id = v_rule AND field = 'gl_code' AND value = '41307');
END $$;

-- ── Comprobacion: las tres reglas, leidas juntas ────────────────────────────
--
-- Recruitment debe quedar igual que B2B:
--
--     seq  connector  field        operator  value   opens  closes
--     1    (null)     gl_code      contains  41309   true   false
--     2    OR         gl_code      equals    41307   false  true
--     3    AND        recruitment  equals    yes     false  false
--
-- select r.name, c.sequence, c.logic_connector, c.field, c.operator, c.value,
--        c.opens_group, c.closes_group
--   from finance_division.split_rule_conditions c
--   join finance_division.split_rules r on r.id = c.split_rule_id
--  where r.name in ('Income: Override margin',
--                   'B2B income: Override margin only',
--                   'Recruitment income:  override margin')
--  order by r.name, c.sequence;
--
-- ⚠ NO SE APLICA SOLO. Las reglas se evaluan al ESCRIBIR. Hasta que se pulse
-- Reapply --con las sucursales marcadas A MANO, porque
-- `app_settings.active_branches` vale `710`-- las 2 filas siguen sin ceco.
