-- ═══════════════════════════════════════════════════════════════════════════
-- comp.payroll_transaction.check_description  ->  description
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APLICADA el 2026-09-16.
--
-- ⚠ ES UN ERROR MIO, Y SE ARREGLA AHORA PORQUE AHORA ES GRATIS. La tabla se
-- aplico con cero filas, sin spec de sync escrito y sin una sola linea de app
-- que la lea. Un rename hoy es una linea; dentro de dos semanas es una linea
-- mas el spec, mas las consultas, mas las pantallas.
--
-- POR QUE ESTABA MAL
--
-- `check_description` YA SIGNIFICA OTRA COSA EN ESTA BASE. Es una columna de
-- `finance_division.pl_transactions` --con sus hermanas `check_description_2`
-- y `check_description_3`-- y es el memo de un apunte del LIBRO MAYOR. La lee
-- media aplicacion:
--
--     lib/cost-center-constants.ts    regla de centro de coste por texto
--     lib/apply-splits.ts             reparto por descripcion
--     lib/apply-oa-splits.ts          idem, con check_description_3
--     lib/generate-employee-fee-lines.ts   el nombre del empleado va ahi
--
-- Y ademas es donde se detecta el B2B success fee, que no tiene gl_code
-- propio (ver la nota de lib/loan-branch.ts).
--
-- La columna de esta tabla es otra cosa distinta: el texto del pago de
-- COMPENSAFE, que en el origen se llama `description` a secas. Dos campos de
-- dos sistemas con el mismo nombre acaban en alguien cruzandolos, o peor,
-- escribiendo una regla de texto pensada para uno y aplicandola al otro.
--
-- ⚠ Y ES EXACTAMENTE EL ERROR QUE ESTA TABLA YA CORRIGE EN OTRA COLUMNA.
-- `gl_code_credit` se espeja como `pay_category` porque su nombre promete un
-- codigo contable y contiene categorias de pago. Haber hecho eso bien en una
-- columna y lo contrario en la de al lado es peor que no haberlo hecho en
-- ninguna: deja la impresion de que los nombres se cuidaron.
--
-- POR QUE `description` Y NO `pay_description`
--
-- Propuse `pay_description`, para que hiciera familia con `pay_date`,
-- `pay_type` y `pay_category`. Se aplico `description`, que es el nombre del
-- origen, y es mejor: el problema era la COLISION con `pl_transactions`, no la
-- falta de un prefijo, y `description` no colisiona con nada. Inventar un
-- tercer nombre habria metido una traduccion mas en el mapeo -- justo lo que
-- `pay_category` cuesta y solo se paga porque alli el nombre de origen MIENTE.
-- Aqui no miente, asi que no hay nada que corregir.

alter table comp.payroll_transaction
  rename column check_description to description;

comment on column comp.payroll_transaction.description is
  'El texto tal cual del pago. Se llama `description` en comp_marts.fct_payroll_transaction. ⚠ NO CONFUNDIR CON finance_division.pl_transactions.check_description, que es el memo de un apunte del libro mayor y lo leen las reglas de centro de coste, los repartos y la deteccion del B2B success fee. Son dos sistemas distintos y una regla de texto escrita para uno no vale para el otro. ⚠ NO ES DECORACION: es lo unico que distingue las cuatro recuperaciones que Jorge Zuzunaga tiene el 2025-11-14, y es de donde se extraen hours_period_from y hours_period_to. Va en la clave porque, al contrario que el periodo, esta siempre.';

comment on column comp.payroll_transaction.txn_key is
  'Clave sintetica: emp_no + pay_date + pay_type + loan_number + description + amount. Sintetica porque el origen NO TRAE NINGUNA columna que sirva de clave. Medido: 1.859 valores distintos sobre 1.859 filas. ⚠ NO LLEVA ORDINAL a proposito: un ROW_NUMBER() solo aguanta mientras la carga sea completa, y esta clave sigue valiendo si pasa a incremental. ⚠ Y NINGUNA COMBINACION MAS CORTA VALE: 77 de las 738 filas de comp.hours_logged vienen de dos lineas con el mismo emp_no, periodo y fecha --un pago y una recuperacion--, Jorge Zuzunaga tiene SEIS lineas el 2025-11-14, y comp.lead_source_check ya midio que un mismo prestamo puede tener dos pagos legitimos la misma fecha.';

comment on column comp.payroll_transaction.hours_period_from is
  'Inicio del periodo de horas, extraido de description. ⚠ PUEDE SER NULL sin que sea un error: solo las lineas de horas lo llevan, y ni todas --en comp.hours_logged son 4 de 731 las que traen una descripcion fuera del patron "Hours entered from M.D.YY to M.D.YY". Una columna que puede faltar no puede ser clave, y por eso la clave lleva el texto entero y no el periodo.';
