-- ═══════════════════════════════════════════════════════════════════════════
-- loan_manual_flags — las clasificaciones que NO vienen de ninguna fuente
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠⚠ YA APLICADO EL 2026-09-13. NO VOLVER A EJECUTAR. ⚠⚠
--
-- Se aplico a mano y el .sql se quedo fuera del historial hasta el
-- 2026-10-08, con la tabla ya en produccion y el codigo de main leyendola.
-- Se commitea para que exista el registro, no para correrlo. (El "NO
-- EJECUTADO" de mas abajo es la nota original de antes de aplicarlo.)
--
-- ─── QUE HARIA REAPLICARLO ─────────────────────────────────────────────────
--
-- El create, los comment, el RLS y el grant son idempotentes. El riesgo esta
-- en el INSERT: con "on conflict do nothing", vuelve a insertar del respaldo
-- cualquiera de los 247 prestamos que YA NO TENGA FILA en la tabla, con sus
-- marcas de entonces.
--
-- Eso NO deshace lo que se cambie en Loan Count: la app quita una marca con un
-- upsert que la deja en false, y una fila que existe no se toca. Lo que si
-- resucitaria es una fila BORRADA por fuera de la app (SQL a mano, limpieza),
-- y con ella marcas que alguien decidio quitar.
--
-- Medido el 2026-10-08: los 247 siguen en la tabla, 0 se recrearian. La tabla
-- tenia 274 filas: 241 file_import + 6 ui_edit de esta migracion, 27 ui
-- marcadas despues en Loan Count.
--
-- NO EJECUTADO. Revisar y aplicar a mano, como las anteriores.
--
-- ─── POR QUE EXISTE ────────────────────────────────────────────────────────
--
-- Loan Count pasa a leer los cierres de activity_report.loan_records_v2, el
-- espejo de lending_marts.fct_commercial_activity que simo-sync ya sincroniza
-- a diario. Ese espejo trae de Encompass y Salesforce casi todo lo que hace
-- falta -- pero NO estas tres clasificaciones, que no existen aguas arriba:
--
--     b2b                 106 prestamos
--     support_on_demand   103
--     processing          150
--                         247 con alguna de las tres, de 436
--
-- Las puso una persona. No hay copia arriba desde la que reconstruirlas.
--
-- ─── POR QUE EN TABLA APARTE Y NO COMO COLUMNAS DEL ESPEJO ─────────────────
--
-- ⚠ ESTA ES LA DECISION QUE PROTEGE EL TRABAJO HUMANO. No la deshagas moviendo
-- estas columnas a loan_records_v2 "para simplificar el join".
--
-- El sync BARRE: borra de la tabla destino las filas que no volvieron a
-- aparecer en la vista de arriba. Si la clasificacion viviera en el espejo, un
-- prestamo que desaparezca de la vista se llevaria la clasificacion con el --
-- y desaparecer es algo que pasa: una reclasificacion aguas arriba, una
-- correccion de counts_for_division, un cambio de criterio en la vista. Aqui
-- sobrevive, y si el prestamo vuelve se vuelve a enganchar solo.
--
-- La leccion ya esta aprendida dos veces en simo-sync, y las dos como parche
-- dentro de una tabla espejo:
--
--   b2b_metrics.master_assignments  en NEVER_WRITE, porque son "decisiones
--                                   humanas sin copia arriba desde la que
--                                   reconstruirlas"
--   org.roster_current              fuera de SWEEPABLE, porque borrar a quien
--                                   desaparecio del archivo "se lleva su
--                                   historia con ella"
--
-- Separandolo, el espejo queda PURO: se puede borrar y reconstruir entero
-- desde BigQuery con riesgo cero, que es lo que un espejo debe ser.
--
-- ─── DOS GESTOS HUMANOS DISTINTOS, Y SE CONSERVA CUAL FUE ──────────────────
--
-- Medido sobre el respaldo: de los 247 clasificados, solo 6 tienen edicion
-- registrada dentro de la app (manually_edited_fields), y los seis son b2b.
-- Los otros 241 llegaron ya marcados en el archivo que alguien subio.
--
-- Los dos son decisiones de una persona, pero en momentos distintos y con
-- trazabilidad distinta. `source` lo conserva en vez de aplanarlo:
--
--     'file_import'  venia marcado en el archivo
--     'ui_edit'      lo cambio alguien dentro de la app antes de la migracion
--     'ui'           lo marca alguien en Loan Count a partir de ahora
--
-- ⚠ Y manually_edited_fields NO sirve como filtro de "lo decidio un humano":
-- solo registra ediciones hechas DENTRO de la app. Los 241 del archivo tambien
-- son humanos y no aparecen ahi. Migrar solo los 6 perderia el 97%.
--
-- ─── DE AGOSTO EN ADELANTE ─────────────────────────────────────────────────
--
-- El archivo se quedo atras: agosto tiene 47 cierres en BigQuery y CERO en
-- loan_officials; septiembre, 10 y cero. Por eso Loan Count gana la casilla
-- para marcar, y por eso 'ui' existe desde el primer dia y no como una
-- ampliacion futura.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance_division.loan_manual_flags (
  -- El prestamo, tal como lo escriben Encompass y loan_records_v2. Sin clave
  -- ajena a ninguna de las dos: esta tabla tiene que poder sobrevivir a que el
  -- prestamo desaparezca del espejo, que es justamente su razon de ser.
  loan_number        text primary key,

  -- Las tres clasificaciones. NULL y false no son lo mismo: NULL es "nadie lo
  -- ha mirado", false es "alguien decidio que no". La pantalla las distingue.
  b2b                boolean,
  support_on_demand  boolean,
  processing         boolean,

  -- De donde salio. Ver la nota de arriba.
  source             text not null default 'ui'
    constraint loan_manual_flags_source_check
    check (source in ('file_import', 'ui_edit', 'ui')),

  -- Quien y cuando. El correo de la sesion, nunca del cuerpo de la peticion --
  -- mismo criterio que el autor de las notas del P&L.
  set_by             text,
  set_at             timestamptz not null default now(),
  note               text
);

comment on table finance_division.loan_manual_flags is
  'Clasificaciones que no existen en ninguna fuente: b2b, support_on_demand y processing. Deliberadamente SEPARADA de activity_report.loan_records_v2, que es un espejo barrido por simo-sync: en el espejo, un prestamo que desapareciera de la vista se llevaria la clasificacion con el. Aqui sobrevive y se vuelve a enganchar si el prestamo vuelve.';

comment on column finance_division.loan_manual_flags.b2b is
  'El b2b MANUAL. No confundir con loan_records_v2.is_b2b, derivado de Salesforce (strategy = B2B). Son DOS DEFINICIONES, ninguna es la mala, y no se unifican: se muestran las dos etiquetadas y se marca donde discrepan. Descomposicion medida el 2026-09-13 sobre los cierres de 2026: 13 salen NPPM en Salesforce porque su estrategia es EXCLUYENTE y la precedencia Affinity > NPPM > Recruitment > B2B > Own Production hace que NPPM absorba a B2B -- una regla, no un error; 9 salen Own Production y son discutibles; y 3 los marca solo Salesforce y no la persona (747002052489, 733002059989, 733002065080), los tres con un Business Developer de dueno y un realtor que refiere. Esos 3 se dejan VISIBLES como discrepancia y no se marcan por nadie que no sea el usuario.';

comment on column finance_division.loan_manual_flags.source is
  'file_import = venia en el archivo subido; ui_edit = editado dentro de la app antes de la migracion; ui = marcado en Loan Count. Los tres son decisiones humanas.';

-- ── La migracion de lo que ya existe ───────────────────────────────────────
--
-- Se copia del RESPALDO y no de loan_officials: es una foto congelada y
-- verificada (b2b 106, support_on_demand 103, processing 150), asi que el
-- resultado se puede comprobar contra numeros que ya se miraron. loan_officials
-- sigue vivo y podria moverse entre que se lee esto y se ejecuta.
--
-- Entran los 247 con alguna de las tres. Los otros 189 no se insertan: no
-- tener fila significa "nadie lo ha clasificado", que es exactamente su estado
-- y es distinto de tres false.
--
-- COMPROBAR DESPUES DE EJECUTAR:
--   select count(*) from finance_division.loan_manual_flags;                  -- 247
--   select count(*) filter (where b2b), count(*) filter (where support_on_demand),
--          count(*) filter (where processing), count(*) filter (where source='ui_edit')
--     from finance_division.loan_manual_flags;                          -- 106, 103, 150, 6

insert into finance_division.loan_manual_flags
  (loan_number, b2b, support_on_demand, processing, source, set_at, note)
select
  b.loan_number,
  b.b2b,
  b.support_on_demand,
  b.processing,
  case
    when coalesce(array_length(b.manually_edited_fields, 1), 0) > 0 then 'ui_edit'
    else 'file_import'
  end,
  coalesce(b.taken_at, now()),
  'Migrado de loan_officials_class_backup_20260913 el 2026-09-13.'
from finance_division.loan_officials_class_backup_20260913 b
where coalesce(b.b2b, false)
   or coalesce(b.support_on_demand, false)
   or coalesce(b.processing, false)
on conflict (loan_number) do nothing;

-- ⚠ NO BORRAR finance_division.loan_officials_class_backup_20260913. Es la
-- unica copia de la que esta migracion se puede rehacer, y el unico sitio donde
-- quedan las clasificaciones del archivo que esta tabla NO se lleva:
--
--   affinity (32) y bd_owner (97)  redundantes: el espejo los trae resueltos en
--                                  is_affinity y bd
--   recruitment (18)               sin equivalente localizado
--   lead_source_lo (390)           CUBIERTO por lead_source de Encompass:
--                                  verificado que son el mismo campo con los
--                                  mismos valores, incluida la grafia rara
--                                  "ILG - In - House". El archivo ademas traia
--                                  4 valores que la fuente no usa -- Encompass
--                                  Integration (47), B2B Strategy (4),
--                                  Referral (3), External Referral (3) -- y 46
--                                  vacios: residuos de captura, no otra
--                                  clasificacion. La fuente es mas limpia.

-- ── Row level security ─────────────────────────────────────────────────────
-- RLS activo, CERO politicas, permisos solo a service_role: el modelo de las
-- otras 20 tablas del esquema. service_role salta RLS, asi que una politica
-- para el no concederia nada y seria la unica del esquema.
--
-- Sin `grant usage on schema`: service_role ya tiene USAGE en finance_division.

alter table finance_division.loan_manual_flags enable row level security;

grant select, insert, update, delete on finance_division.loan_manual_flags to service_role;
