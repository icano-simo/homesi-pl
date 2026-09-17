-- ═══════════════════════════════════════════════════════════════════════════
-- comp.payroll_transaction — el espejo de comp_marts.fct_payroll_transaction
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APLICADA el 2026-09-16 (20260916213743 comp_payroll_transaction). El orden
-- del patron es: (1) esta tabla, (2) el usuario la aplica, (3) el spec en
-- simo-sync grupo comp, (4) y solo entonces la app.
--
-- ⚠ UNA COLUMNA CAMBIO DE NOMBRE DESPUES DE APLICAR ESTA. `check_description`
-- pasa a `description` en
-- `20260916_comp_payroll_transaction_rename_description.sql`, porque
-- `check_description` ya significa otra cosa en `pl_transactions`. Este
-- archivo se deja como se aplico; el nombre vigente es el de alli.
--
-- POR QUE EXISTE
--
-- Hoy "Loan officer payroll" es un total opaco: el modulo de P&L por Loan
-- Officer suma las cuentas 60105, 60115 y 60117 del P&L y ensena una sola
-- cifra. Contesta "cuanto se le pago" y no contesta "por que". Compensafe si
-- lo sabe, linea a linea. Medido sobre 1.859 filas:
--
--     Commission            549 lineas     1.288.545
--     Other                 760 lineas     1.241.645   (564 de ellas, horas)
--     Bonus                 264 lineas       574.391
--     Earnings Recapture    252 lineas      -203.614
--     Override               34 lineas        39.412
--
-- Las horas son 1,24 millones, casi tanto como las comisiones, y estan hoy
-- dentro del mismo numero sin manera de separarlas. Ese es el motivo.
--
-- ⚠ EL 564 DE ARRIBA ESTA DENTRO DE `Other`. Las lineas de horas de la tabla
-- entera son 815: las otras 251 estan en Earnings Recapture. Las dos cifras
-- son correctas sobre alcances distintos -- ver la seccion de `is_hourly`.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ LA CLAVE. EL ORIGEN NO TRAE NINGUNA, Y LA DE NEGOCIO BASTA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fct_payroll_transaction` no tiene ninguna columna que sirva de clave
-- propia --ni transaction_id ni numero de linea-- asi que la clave es
-- sintetica por necesidad, no por gusto. Medido sobre las 1.859 filas:
--
--     emp_no | pay_date | pay_type | loan_number | check_description | amount
--         -> 1.859 claves distintas de 1.859 filas
--
-- ⚠ Y NO LLEVA ORDINAL, A PROPOSITO. Un ROW_NUMBER() dentro de la colision
-- habria hecho la clave unica por construccion, pero no es estable: el job lee
-- la vista entera en cada corrida, y un ROW_NUMBER() sin `ORDER BY`
-- determinista se recalcula cada vez -- sin que nada en estos datos de un
-- orden natural del que colgarlo. Una clave de negocio no tiene ese problema:
-- los seis campos valen lo mismo se lean cuando se lean.
--
-- ⚠ AQUI DECIA ALGO FALSO Y SE CORRIGE EN
-- `20260916_comp_payroll_transaction_clave_sha256.sql`. Decia que el ordinal
-- "solo aguanta mientras la carga sea completa -- simo-sync borra y reescribe
-- el lote entero, medido: un unico synced_at por tabla". La MEDICION era
-- cierta y lo sigue siendo; la CONCLUSION no se seguia de ella. `synced_at`
-- es uniforme porque el job estampa la marca de la corrida en cada fila que
-- escribe, no porque el origen se recargue entero -- y Compensafe SI carga
-- incremental: el 2026-09-16 trajo 49 filas de un solo corte de pago.
--
-- ⚠ Y `txn_key` NO ES LA CONCATENACION QUE SE LEE ABAJO: es su SHA256, de 64
-- hex, calculado en la vista. Los seis campos son los mismos. Ver esa misma
-- migracion.
--
-- ⚠ NO HACEN FALTA MAS CAMPOS. `adj_type`, `effective_date` y `scenario`
-- anadidos a la clave dan tambien 1.859: no distinguen ninguna fila que las
-- seis no distingan ya. Entran como columnas, no como clave.
--
-- POR QUE HACEN FALTA LAS SEIS, Y NINGUNA SOBRA
--
-- El grano es la linea, y a este grano ninguna combinacion corta es unica.
-- Medido contra `comp.hours_logged`, el espejo del mismo origen:
--
--     556 grupos (emp_no + periodo desde + periodo hasta)
--     156 de ellos se pagan en MAS DE UNA FECHA         -- el 28%
--     178 filas colisionarian sin `pay_date` en la clave
--       4 fechas de pago distintas para un mismo periodo, en el peor caso
--
-- Ese es el precedente de hours_logged, y sigue vivo: era 89 colisiones de
-- 448 filas cuando se escribio y hoy son 178. Pero aqui el grano es la linea
-- y eso rompe tambien la clave CON `pay_date` dentro:
--
--     661 filas del mart vienen de 1 linea de origen
--      77 filas del mart vienen de 2      -- 738 filas, 815 lineas
--
-- Esas 77 son un pago y una recuperacion sobre el MISMO emp_no, el MISMO
-- periodo y la MISMA fecha de pago:
--
--     lines=1  had_recapture=false   488 grupos   pagado  686.254
--     lines=1  had_recapture=true    173 grupos   recuperado -125.524
--     lines=2  had_recapture=true     77 grupos   pagado 81.596 / recup. -77.840
--
-- Y el caso de Jorge Zuzunaga es peor que dos. El 2025-11-14, una persona,
-- una fecha de pago, SEIS lineas:
--
--     periodo 2025-08-16 a 08-31    recuperado    -420,00
--     periodo 2025-09-01 a 09-15    recuperado  -1.005,00
--     periodo 2025-09-16 a 09-30    recuperado  -1.327,50
--     periodo 2025-10-01 a 10-15    recuperado  -1.320,00
--     periodo 2025-10-16 a 10-31    pagado       1.800,00  y en la misma
--                                   recuperado    -787,50  fecha y periodo
--
-- Cobra horas cada quincena, cierra un prestamo, y le descuentan de golpe
-- todas las quincenas anteriores. De ahi sale que la clave necesite las seis:
--
--     emp_no + pay_date                       no basta  (las 6 lineas)
--     + pay_type                              no basta  (4 recuperaciones)
--     + loan_number                           no basta: la nota de
--         `comp.lead_source_check` ya lo midio -- un mismo prestamo puede
--         tener DOS pagos legitimos la misma fecha, un adelanto de 500 y
--         luego el resto. Eran 467 filas con el importe en la clave y 463 sin
--         el: cuatro pagos reales desaparecian.
--     + check_description                     separa los cuatro periodos
--     + amount                                separa el adelanto del resto
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LAS DECISIONES SOBRE LAS COLUMNAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ `emp_no` ES LA IDENTIDAD, NO `person_code`. Es el precedente de
-- hours_logged y hoy pesa mas que cuando se escribio: de sus 738 filas,
-- 162 --el 22%-- no tienen `person_code`, y ninguna se queda sin `emp_no`.
-- Colgar la tabla de person_code dejaria fuera una de cada cinco lineas de
-- nomina, que son justo las de la gente que no esta dada de alta en RRHH.
--
-- ⚠ `check_description` NO ES DECORACION, ES DATO. Es lo unico que separa las
-- cuatro recuperaciones del 2025-11-14, y es donde vive el periodo de horas:
-- `hours_period_from` y `hours_period_to` salen de ese texto y no de una
-- columna del origen. Por eso pueden ser NULL sin que sea un error --en
-- hours_logged son 4 de 731 las que no siguen el patron "Hours entered from
-- M.D.YY to M.D.YY"-- y por eso ninguna de las dos puede formar parte de la
-- clave, aunque `check_description`, que si esta siempre, si lo sea.
--
-- ⚠ `pay_category` SE LLAMA `gl_code_credit` EN EL ORIGEN, Y ESE NOMBRE
-- MIENTE. Promete un codigo de cuenta contable y no lo es: son categorias de
-- pago. Medido:
--
--     Non-Recoverable Hours     253 lineas    +475.082   pay_type Other
--     Recoverable Hours         251 lineas    -203.364   Earnings Recapture
--     Non-Recoverable Salary    190 lineas    +464.795   Other
--     Recoverable Salary          1 linea        -250    Earnings Recapture
--     nulo                      Commission 549, Bonus 264, Override 34
--
-- Se renombra al espejarla porque el nombre del origen induce a usarla para
-- cuadrar contra el P&L, y no cuadra nada: no hay un solo gl_code ahi dentro.
--
-- ⚠ PERO VALE PARA ALGO MEJOR QUE CUADRAR: distingue las horas RECUPERABLES
-- de las que no. Eso es exactamente el mecanismo de Zuzunaga --cobra horas
-- cada quincena y al cerrar un prestamo se las descuentan-- y permite que la
-- tarjeta diga cuanto de lo pagado por horas es un ADELANTO y cuanto es
-- dinero que se queda. Sin esta columna las dos cosas son el mismo numero.
--
-- ⚠ `is_hourly` E `is_recapture` SON DOS COLUMNAS DISTINTAS, no una. Y las
-- tres maneras de preguntar por una recuperacion coinciden HOY:
--
--     pay_type = 'Earnings Recapture'              252 lineas
--     pay_category LIKE 'Recoverable%'             251 + 1 = 252
--     is_recapture                                 252
--
-- Se guardan las tres. El dia que dejen de coincidir, esa discrepancia es un
-- hallazgo sobre el origen, y solo se puede ver si estan las tres.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠⚠ PARA CONTAR HORAS SE USA `is_hourly`, NUNCA `pay_category`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Y ES JUSTO LO CONTRARIO DE LO QUE PARECE. `pay_category` tiene el nombre
-- mas especifico --dice "Hours" en el valor-- y es la que cubre MENOS.
-- Medido sobre las 1.859 filas:
--
--     is_hourly = true                                 815 lineas
--         311  sin categoria          +292.768   pay_type Other
--         253  Non-Recoverable Hours  +475.082   pay_type Other
--         251  Recoverable Hours      -203.364   Earnings Recapture
--
-- Las 311 sin categoria son pagos de horas REALES, no datos rotos: su
-- descripcion es "Hourly Wages Paid on 9.30.25", "10.15.25", "11.14.25"...
-- TODAS son de 2025, de septiembre a enero. Las que si llevan categoria son
-- de 2026. Compensafe empezo a clasificar los pagos en algun momento y lo
-- anterior se quedo sin clasificar.
--
-- Asi que `pay_category` cubre solo las 504 lineas de 2026, e `is_hourly`
-- cubre las 815. Contar horas por `pay_category` pierde un ano entero de
-- historia sin que nada falle ni avise: el numero simplemente sale mas
-- pequeno. `pay_category` sirve para lo que sirve --separar recuperable de no
-- recuperable-- y esa pregunta tampoco tiene respuesta antes de 2026.
--
-- ⚠ NI UNA NI OTRA SE DERIVAN AQUI. Separar las horas leyendo
-- `check_description` en la app daria una segunda normalizacion, y dos
-- normalizaciones distintas dan dos respuestas que se separan sin que nada
-- falle. Es la misma razon por la que `lib/lo-payroll-name.ts` no
-- re-normaliza los nombres que ya normalizo el mart.
--
-- ⚠ Y AL CONTARLAS, DECIR SOBRE QUE. Las horas son 815 lineas en la tabla
-- entera y 564 dentro de `pay_type = 'Other'` --las otras 251 son
-- Earnings Recapture--. Las dos cifras son correctas y miden cosas
-- distintas; escritas sin su alcance parecen un descuadre de 251 lineas. Ver
-- `docs/notas-que-dependen-del-alcance.md`.
--
-- ⚠ `loan_branch_code` NO ES `branch_code`. Uno es la sucursal de la PERSONA
-- y el otro la del PRESTAMO, y el modulo entero depende de esa diferencia:
-- la escalera restringe el revenue de cada prestamo a su propia sucursal, y
-- las siete sucursales con prestamos y sin nadie en el roster
-- --379.764,07 de nomina sin atribuir, el 72,6% del total-- son exactamente
-- los casos donde las dos no coinciden. Ver `lib/loan-branch.ts`.
--
-- ⚠ `hr_position` ENTRA, PERO EL ROSTER MANDA. `org.roster_current` es de
-- donde sale el puesto de una persona y esto no lo sustituye. Entra porque
-- para las lineas que el roster NO puede contestar --el 22% sin person_code--
-- es la unica informacion de puesto que existe. La regla es: si los dos
-- dicen algo, gana el roster; esta columna solo habla cuando el otro calla.
--
-- ⚠ `plan_name` Y `scenario` NO SIGNIFICAN NADA POR SEPARADO. La nota de
-- `comp.lead_source_check` lo dejo escrito: el lead source es DERIVADO del
-- par --"BR nnn Plan + Base Plan" es Self-Generated, plan "Friends & Family"
-- es Friends and Family-- y "Base Plan" aparece cuatro veces por persona
-- significando cosas distintas. Se guardan los dos crudos y la
-- interpretacion vive en el mart, no aqui.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LO QUE SE DEJA FUERA, Y POR QUE
-- ═══════════════════════════════════════════════════════════════════════════
--
--   bps                EXCLUIDA, Y MEDIDO. Es `amount` / `loan_amount` *
--                      10.000 en las 739 filas que tienen los dos campos, sin
--                      una sola excepcion. No es la tarifa pactada: es la
--                      efectiva, o sea exactamente derivable de las dos
--                      columnas que tiene al lado. Y la app ya calcula bps
--                      contra `loan_officials`. Guardarla seria un segundo
--                      numero contestando la misma pregunta, que se separa
--                      del primero el dia que uno de los dos denominadores
--                      cambie.
--                      ⚠ LA MEDICION ES LO QUE CIERRA ESTO, no el parecido de
--                      las formulas. Se dejo abierta hasta tenerla porque una
--                      tarifa pactada habria sido otro hecho y habria tenido
--                      que entrar.
--
--   debit_credit       El signo, y `amount` ya lo lleva: las recuperaciones
--                      son negativas (-203.614 medido). Dos fuentes para el
--                      mismo signo es una de mas.
--                      ⚠ Si resultara que `amount` viene SIN signo, entonces
--                      esta columna no se guarda tampoco: se aplica en el
--                      sync antes de escribir, para que nadie pueda leer el
--                      importe sin ella.
--
--   borrower           Se obtiene por `loan_number` desde
--                      `comp.loan_commission`, que ya lo trae. Un nombre de
--                      cliente escrito en dos sitios son dos grafias.
--
--   loan_branch_name   El nombre del codigo que ya esta en
--                      `loan_branch_code`, y el catalogo de sucursales es
--                      `finance_division.branches`. Misma razon.
--
--   property_state     Es un hecho del inmueble, no del pago. Si algun dia
--                      hace falta, su sitio es `loan_officials`.
--
--   person_country     Ninguna pregunta de este modulo depende de el, y la
--                      ficha de la persona es el roster.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LO QUE ESTA TABLA NO HACE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ NO SUSTITUYE A `comp.hours_logged`, Y NO SE PUEDEN SUMAR LAS DOS. No es
-- que "se solapen": casi con seguridad son EL MISMO CONJUNTO. hours_logged
-- tiene 738 filas construidas sobre 815 lineas de origen (661 de una linea +
-- 77 de dos), e `is_hourly` marca aqui 815 lineas. El mismo numero exacto, y
-- lo unico que cambia es que alli vienen agrupadas por periodo y con el neto
-- ya calculado.
--
-- ⚠ LA IGUALDAD ES FUERTE PERO NO ES UNA PRUEBA -- una consulta que cruce los
-- dos conjuntos la cierra, y merece la pena hacerla antes de que ninguna
-- pantalla lea las dos tablas. Quien las sume esta contando las horas dos
-- veces, y son 1,24 millones. La regla mientras tanto: esta tabla para el
-- desglose por linea, hours_logged para la pregunta "cuanto neto de horas
-- tiene esta persona en este periodo".
--
-- ⚠ NO CUADRA CON EL P&L POR `pay_date`, NI DEBE ESPERARSE QUE CUADRE.
-- Compensafe agrupa por fecha de cierre y el P&L por fecha de pago; la nota
-- de `PRODUCTION_PAY_GL_CODES` en `lib/loan-detail-accounts.ts` lo tiene
-- medido: 7 de 39 officers casan al euro. Comparado asi, el numero significa
-- "lo que falta por pagar o se pago de antes", no un descuadre. Y
-- `pay_category` NO arregla esto: no trae codigos contables.
--
-- ⚠ PERO `effective_date` SI LO ARREGLA, Y ES LO MEJOR QUE TRAE ESTA TABLA.
-- Medido: es la fecha de cierre --coincide con completed_date en 494 de 511
-- lineas de comision, el 97%-- y es anterior a pay_date en 1.842 de 1.859,
-- con 16,6 dias de media. Comparando por effective_date los dos calendarios
-- son el mismo, y un descuadre pasa a ser un descuadre de verdad.
-- ⚠ ESO NO CAMBIA NADA POR SI SOLO: lo que compara hoy la pantalla sigue
-- siendo por fecha de pago, y cambiarlo es una decision aparte, con su
-- medicion, no un efecto secundario de espejar esta columna.
--
-- ⚠ NO LLEVA CHECK SOBRE `pay_type` NI SOBRE `pay_category`. Los valores
-- medidos son los de hoy. Una restriccion los congelaria y el dia que
-- aparezca uno nuevo tumbaria la carga entera en vez de ensenarlo.

create table if not exists comp.payroll_transaction (
  txn_key            text        primary key,

  -- quien
  emp_no             text        not null,
  person_code        text,
  person_name        text,
  employee_in_file   text,
  unmatched_person   boolean     not null default false,
  hr_position        text,
  branch_code        text,

  -- sobre que prestamo
  loan_number        text,
  loan_branch_code   text,
  loan_amount        numeric,

  -- cuando
  pay_date           date        not null,
  effective_date     date,
  hours_period_from  date,
  hours_period_to    date,

  -- que clase de pago
  pay_type           text        not null,
  pay_category       text,
  adj_type           text,
  plan_name          text,
  scenario           text,
  is_hourly          boolean     not null default false,
  is_recapture       boolean     not null default false,

  -- cuanto, y con que texto
  check_description  text,
  amount             numeric     not null,

  synced_at          timestamptz not null default now()
);

create index if not exists payroll_txn_person_idx
  on comp.payroll_transaction (person_code);

create index if not exists payroll_txn_emp_date_idx
  on comp.payroll_transaction (emp_no, pay_date);

create index if not exists payroll_txn_pay_date_idx
  on comp.payroll_transaction (pay_date);

create index if not exists payroll_txn_type_idx
  on comp.payroll_transaction (pay_type);

create index if not exists payroll_txn_loan_idx
  on comp.payroll_transaction (loan_number)
  where loan_number is not null;

-- Las lineas que el mart no consiguio casar con una persona. Es la pregunta
-- abierta del modulo --523.207,01 en 84 nombres sin atribuir-- y se consulta
-- como excepcion, no como recorrido.
create index if not exists payroll_txn_unmatched_idx
  on comp.payroll_transaction (unmatched_person)
  where unmatched_person;

-- Igual que hours_logged y loan_commission: RLS activo y SIN politica. La app
-- lee `comp` con la service role desde el servidor (lib/supabase-server.ts),
-- que salta RLS; nadie llega a esta tabla desde el navegador. La politica
-- para `authenticated` existe solo en lead_source_check y no se replica aqui
-- porque ninguna pantalla la necesita.
alter table comp.payroll_transaction enable row level security;

grant select, insert, update, delete on comp.payroll_transaction to service_role;

comment on table comp.payroll_transaction is
  'Espejo de comp_marts.fct_payroll_transaction (BigQuery), escrito por simo-sync. Grano: UNA LINEA de nomina de Compensafe. Existe para desagregar lo que en el modulo de P&L por Loan Officer es hoy un total opaco, "Loan officer payroll": 1.859 lineas repartidas en Commission 549, Other 760, Bonus 264, Earnings Recapture 252 y Override 34. ⚠ LAS HORAS SON 815 LINEAS Y CRUZAN DOS pay_type: 564 dentro de Other y 251 dentro de Earnings Recapture. Se cuentan por is_hourly, nunca por pay_category -- ver el comentario de esas dos columnas. ⚠ SE SOLAPA CON comp.hours_logged y no se pueden sumar las dos: las lineas de horas estan en las dos tablas, aqui sueltas y alli agrupadas por periodo.';

comment on column comp.payroll_transaction.txn_key is
  'Clave sintetica: emp_no + pay_date + pay_type + loan_number + check_description + amount. Sintetica porque el origen NO TRAE NINGUNA columna que sirva de clave. Medido: 1.859 valores distintos sobre 1.859 filas. ⚠ NO LLEVA ORDINAL a proposito: un ROW_NUMBER() solo aguanta mientras la carga sea completa, y esta clave sigue valiendo si pasa a incremental. ⚠ Y NINGUNA COMBINACION MAS CORTA VALE: 77 de las 738 filas de comp.hours_logged vienen de dos lineas con el mismo emp_no, periodo y fecha --un pago y una recuperacion--, Jorge Zuzunaga tiene SEIS lineas el 2025-11-14, y comp.lead_source_check ya midio que un mismo prestamo puede tener dos pagos legitimos la misma fecha.';

comment on column comp.payroll_transaction.emp_no is
  'Identidad estable de la persona, y la razon de que no sea person_code: de las 738 filas de comp.hours_logged, 162 --el 22%-- no tienen person_code y ninguna se queda sin emp_no. Son justo las lineas de quien no esta dado de alta en RRHH, que es la gente por la que se pregunta.';

comment on column comp.payroll_transaction.unmatched_person is
  'El mart no consiguio casar esta linea con una persona. ⚠ NO ES LO MISMO QUE person_code IS NULL, aunque hoy se parezcan: uno es el veredicto del mart y el otro la ausencia de un dato. Es la puerta de entrada a la pregunta abierta del modulo -- 523.207,01 de nomina en 84 nombres que no se atribuyen a nadie, de los cuales 379.764,07 caen en siete sucursales sin nadie en el roster (ver lib/loan-branch.ts).';

comment on column comp.payroll_transaction.hr_position is
  'Puesto segun el archivo de nomina. ⚠ NO SUSTITUYE AL ROSTER: org.roster_current es de donde sale el puesto de una persona y gana cuando los dos dicen algo. Esta columna existe porque para el 22% de lineas sin person_code es la unica informacion de puesto que hay.';

comment on column comp.payroll_transaction.loan_branch_code is
  'La sucursal del PRESTAMO. ⚠ NO ES branch_code, que es la de la PERSONA, y el modulo entero depende de esa diferencia: la escalera restringe el revenue de cada prestamo a su propia sucursal. Donde las dos no coinciden estan las siete sucursales con prestamos y sin roster. Ver lib/loan-branch.ts.';

comment on column comp.payroll_transaction.pay_category is
  'Se llama gl_code_credit en el origen Y ESE NOMBRE MIENTE: promete un codigo de cuenta contable y son categorias de pago. Medido: Non-Recoverable Hours 253 lineas +475.082 · Recoverable Hours 251 -203.364 · Non-Recoverable Salary 190 +464.795 · Recoverable Salary 1 -250 · nulo en Commission, Bonus y Override. ⚠ NO SIRVE PARA CUADRAR CONTRA EL P&L -- no hay un solo gl_code ahi dentro. Sirve para algo mejor: distingue las horas RECUPERABLES de las que no, o sea que separa un adelanto del dinero que se queda. Es el mecanismo de Zuzunaga hecho visible. ⚠ PERO NO SIRVE PARA CONTAR HORAS, Y SU NOMBRE ENGANA: solo cubre 2026. Las 311 lineas de horas de 2025 vienen sin categoria porque Compensafe empezo a clasificar despues. Para contar horas se usa is_hourly, que cubre las 815. Y eso significa que "recuperable o no" TAMPOCO tiene respuesta antes de 2026: ahi la ausencia de categoria no es un no, es un no consta.';

comment on column comp.payroll_transaction.is_hourly is
  'ESTA es la columna para contar horas, NUNCA pay_category, y es lo contrario de lo que parece: pay_category tiene el nombre mas especifico y cubre menos. Medido: is_hourly marca 815 lineas -- 311 sin categoria (+292.768, pay_type Other), 253 Non-Recoverable Hours (+475.082, Other) y 251 Recoverable Hours (-203.364, Earnings Recapture). Las 311 son pagos de horas REALES, no datos rotos: "Hourly Wages Paid on 9.30.25", "10.15.25"... todas de 2025, de septiembre a enero. Compensafe empezo a clasificar en 2026 y lo anterior quedo sin categoria. Contar horas por pay_category pierde un ano entero sin que nada avise. ⚠ Y viene del mart, no se deriva del texto aqui: dos normalizaciones de la misma descripcion dan dos respuestas que se separan sin que nada falle. ⚠ AL ENSENARLAS, DECIR SOBRE QUE: son 815 en la tabla entera y 564 dentro de pay_type = Other.';

comment on column comp.payroll_transaction.is_recapture is
  'Dinero que se devuelve. ⚠ HAY TRES MANERAS DE PREGUNTAR LO MISMO y hoy las tres coinciden: pay_type = Earnings Recapture son 252 lineas, pay_category LIKE Recoverable% son 251 + 1 = 252, e is_recapture son 252. Se guardan las tres a proposito: el dia que dejen de coincidir, la discrepancia es un hallazgo sobre el origen, y solo se ve si estan las tres.';

comment on column comp.payroll_transaction.check_description is
  'El texto tal cual del pago. ⚠ NO ES DECORACION: es lo unico que distingue las cuatro recuperaciones que Zuzunaga tiene el 2025-11-14, y es de donde se extraen hours_period_from y hours_period_to. Va en la clave porque, al contrario que el periodo, esta siempre.';

comment on column comp.payroll_transaction.hours_period_from is
  'Inicio del periodo de horas, extraido de check_description. ⚠ PUEDE SER NULL sin que sea un error: solo las lineas de horas lo llevan, y ni todas --en comp.hours_logged son 4 de 731 las que traen una descripcion fuera del patron "Hours entered from M.D.YY to M.D.YY". Una columna que puede faltar no puede ser clave, y por eso la clave lleva el texto entero y no el periodo.';

comment on column comp.payroll_transaction.amount is
  'Importe CON SIGNO. Las lineas de Earnings Recapture son negativas --252 lineas, -203.614 en total-- y asi deben guardarse: son dinero que se devuelve, no un importe al que le falte el signo. Guardar el valor absoluto convertiria una devolucion en un pago. Por eso no se espeja debit_credit: el signo ya esta aqui, y dos fuentes para el mismo signo es una de mas.';

comment on column comp.payroll_transaction.loan_amount is
  'El importe del prestamo tal como lo vio Compensafe al calcular esta linea. ⚠ SU `bps` NO SE ESPEJA, Y ESTA MEDIDO: es amount/loan_amount*10.000 en las 739 filas que tienen los dos campos, sin una sola excepcion. Es la bps EFECTIVA, no la tarifa pactada, o sea derivable de esta columna y la de al lado -- y la app ya calcula bps contra loan_officials. Dos numeros guardados contestando "cuantos bps es esto" se separan el dia que uno de los dos denominadores cambie.';

comment on column comp.payroll_transaction.pay_type is
  'Commission, Other, Bonus, Earnings Recapture, Override. ⚠ SIN CHECK a proposito: son los cinco valores medidos hoy, y congelarlos haria que un sexto tumbara la carga entera en vez de ensenarse.';

comment on column comp.payroll_transaction.plan_name is
  'El plan de compensacion, crudo. ⚠ NO SIGNIFICA NADA SIN scenario: el lead source es DERIVADO del par, y "Base Plan" aparece cuatro veces por persona significando cosas distintas. La interpretacion vive en comp_marts.mart_lead_source_check, no aqui.';

comment on column comp.payroll_transaction.scenario is
  'El escenario del plan, crudo. Se lee junto a plan_name -- ver el comentario de esa columna. No entra en la clave: anadirlo da tambien 1.859, o sea que no distingue ninguna fila.';

comment on column comp.payroll_transaction.adj_type is
  'Tipo de ajuste. No entra en la clave: anadirlo da tambien 1.859 sobre 1.859. Entra como columna porque es una distincion que no se deriva de ninguna otra y el objeto de esta tabla es justamente desagregar.';

comment on column comp.payroll_transaction.effective_date is
  'ES LA FECHA DE CIERRE, medido: coincide con completed_date en 494 de 511 lineas de comision (97%) y es anterior a pay_date en 1.842 de 1.859, con 16,6 dias de media. ⚠ ESTA COLUMNA RESUELVE EL DESFASE DE LOS DOS CALENDARIOS, que es el motivo de que solo 7 de 39 officers casen al euro: Compensafe agrupa por fecha de cierre y el P&L por fecha de pago (ver PRODUCTION_PAY_GL_CODES en lib/loan-detail-accounts.ts). Con effective_date, comparar comision contra nomina se puede hacer por la MISMA fecha, y la comparacion pasa a significar un descuadre de verdad en vez de "lo que falta por pagar o se pago de antes". No entra en la clave: anadirla da tambien 1.859.';

comment on column comp.payroll_transaction.loan_number is
  'Solo lo llevan las lineas ligadas a un prestamo. Cruza con finance_division.loan_officials y con comp.loan_commission sin transformar nada.';

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTA SOBRE LA TABLA DE AL LADO: comp.lead_source_check ESTA VACIA A PROPOSITO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tiene 0 filas y `synced_at` nulo mientras hours_logged trae 738 y
-- loan_commission 470 del mismo lote. NO ES UN FALLO DE CARGA: se puso en
-- espera por decision del usuario, se creo la tabla y el spec no se activo.
--
-- Queda escrito aqui porque su estado se parece exactamente a una carga rota,
-- y sin esta nota el siguiente que lo mida lo va a reportar como bug --como
-- se reporto el 2026-09-16 antes de saberlo. Cuando se retome, lo unico que
-- falta es el spec.
