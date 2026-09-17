-- ═══════════════════════════════════════════════════════════════════════════
-- Las siete columnas que volvieron, y la que tiene un nombre que miente
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ NO EJECUTADA. Se escribe para que la aplique el usuario. SOLO CAMBIA
-- COMENTARIOS: ni una fila, ni una columna, ni un permiso.
--
-- QUE PASO
--
-- La tabla se diseño con 25 columnas, dejando fuera seis del origen a
-- proposito y renombrando `gl_code_credit` a `pay_category` porque su nombre
-- promete algo que no es. Al crear `comp_marts.fct_payroll_transaction_v`, la
-- vista espejo las 31 columnas del origen tal cual, y con ellas volvieron las
-- seis y el nombre viejo.
--
-- ⚠ NO SE REVIERTE, Y ESA ES LA DECISION. El sync funciona con las 1.859
-- filas; romperlo por un nombre no compensa. Lo que NO puede quedarse es el
-- aviso perdido: sin el, alguien va a intentar cuadrar el P&L por
-- `gl_code_credit` --que es justo lo que su nombre invita a hacer-- y va a
-- perder una tarde averiguando que ahi dentro no hay un solo codigo contable.
--
-- Asi que el nombre se queda y el aviso se pone en el unico sitio donde quien
-- lo necesita lo va a ver: el comentario de la propia columna.
--
-- ⚠ Y `is_hourly` SE REESCRIBE PORQUE SU COMENTARIO SEÑALABA A `pay_category`,
-- una columna que ya no existe. Una nota que nombra algo inexistente es peor
-- que ninguna: manda a buscar y no se encuentra.

-- ═══════════════════════════════════════════════════════════════════════════
-- LA QUE IMPORTA
-- ═══════════════════════════════════════════════════════════════════════════

comment on column comp.payroll_transaction.gl_code_credit is
  '⚠ ESTE NOMBRE MIENTE, Y ES LA UNICA COLUMNA DE LA TABLA QUE LO HACE. Promete un codigo de cuenta contable y lo que trae son CATEGORIAS DE PAGO. Medido el 2026-09-16 sobre las 1.859 filas: Non-Recoverable Hours 253 lineas +475.082 · Recoverable Hours 251 -203.364 · Non-Recoverable Salary 190 +464.795 · Recoverable Salary 1 -250 · y NULO en las 847 de Commission, Bonus y Override. ⚠ NO SIRVE PARA CUADRAR CONTRA EL P&L -- no hay un solo gl_code ahi dentro, y es exactamente lo que el nombre invita a intentar. ⚠ TAMPOCO SIRVE PARA CONTAR HORAS: solo cubre 2026, porque Compensafe empezo a clasificar entonces y las 311 lineas de horas de 2025 quedaron sin categoria. Contar por aqui pierde un año entero sin que nada falle, el numero solo sale mas pequeño. Para las horas, is_hourly, que cubre las 815. ⚠ Y ANTES DE 2026 "recuperable o no" NO TIENE RESPUESTA: ahi el nulo es un "no consta", no un "no". PARA QUE SI SIRVE, de 2026 en adelante: separar las horas RECUPERABLES de las que no, o sea un adelanto del dinero que se queda. Es el mecanismo de Jorge Zuzunaga --cobra horas cada quincena y al cerrar un prestamo se las descuentan-- hecho visible. Se iba a espejar como `pay_category` por todo esto; el nombre del origen volvio al crear la vista y se deja, pero el aviso vive aqui.';

comment on column comp.payroll_transaction.bps is
  '⚠ NO ES UN HECHO INDEPENDIENTE: es amount / loan_amount * 10.000, medido el 2026-09-16 en las 739 filas que tienen los dos campos, SIN UNA SOLA EXCEPCION. Es la bps EFECTIVA, no una tarifa pactada. Se habia dejado fuera del espejo por eso --dos numeros guardados contestando "cuantos bps es esto" se separan el dia que uno de los dos denominadores cambie-- y volvio al crear la vista, que espejo las 31 columnas del origen. No estorba y se queda, pero que nadie la tome por un dato que el origen sepa y aqui no se pueda calcular. La app NO la lee: calcula bps contra finance_division.loan_officials.';

-- ═══════════════════════════════════════════════════════════════════════════
-- LA QUE SEÑALABA A UNA COLUMNA QUE YA NO EXISTE
-- ═══════════════════════════════════════════════════════════════════════════

comment on column comp.payroll_transaction.is_hourly is
  'ESTA es la columna para contar horas, NUNCA gl_code_credit, y es lo contrario de lo que sugieren los nombres: la columna cuyo VALOR dice "Hours" es la que cubre menos. Medido: is_hourly marca 815 lineas -- 311 sin categoria (+292.768), 253 Non-Recoverable Hours (+475.082) y 251 Recoverable Hours (-203.364). Las 311 son pagos de horas REALES, no datos rotos: "Hourly Wages Paid on 9.30.25", "10.15.25"... todas de 2025, de septiembre a enero, porque Compensafe empezo a clasificar en 2026. Contar por gl_code_credit pierde ese año sin que nada avise. ⚠ AL ENSEÑARLAS, DECIR SOBRE QUE ALCANCE: son 815 en la tabla entera y 564 dentro de pay_type = Other, porque las otras 251 estan en Earnings Recapture. Las dos cifras son correctas y miden cosas distintas. ⚠ Y AL CLASIFICAR, is_recapture VA ANTES que is_hourly: las 251 lineas de recuperacion de horas llevan LAS DOS banderas, y al reves contarian como horas cobradas -- 203.363,77 cambiando de signo. El clasificador vive en lib/payroll-categories.ts de homesi-pl.';

-- ═══════════════════════════════════════════════════════════════════════════
-- LAS OTRAS CINCO QUE VOLVIERON. Ninguna se lee hoy.
-- ═══════════════════════════════════════════════════════════════════════════

comment on column comp.payroll_transaction.debit_credit is
  'El signo del apunte. ⚠ REDUNDANTE: `amount` YA VIENE CON SIGNO --las 252 lineas de Earnings Recapture suman -203.614-- asi que esta columna no añade nada y no se lee. Dos fuentes para el mismo signo es una de mas: quien las use tiene que elegir cual manda, y no hay criterio para elegir. Volvio al espejar las 31 columnas del origen.';

comment on column comp.payroll_transaction.borrower is
  'El cliente del prestamo. Redundante: se obtiene por loan_number desde comp.loan_commission, que ya lo trae. Un nombre de cliente escrito en dos sitios acaba siendo dos grafias. No se lee.';

comment on column comp.payroll_transaction.loan_branch_name is
  'El nombre de la sucursal que ya esta en loan_branch_code. El catalogo de sucursales es finance_division.branches, y esa es la autoridad. No se lee.';

comment on column comp.payroll_transaction.property_state is
  'El estado del inmueble. Es un hecho del PRESTAMO, no del pago, y su sitio seria loan_officials. No se lee.';

comment on column comp.payroll_transaction.person_country is
  'El pais de la persona. La ficha de la persona es org.roster_current. Ninguna pregunta de este modulo depende de el. No se lee.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Y LAS QUE NUNCA TUVIERON COMENTARIO Y SI SE LEEN
-- ═══════════════════════════════════════════════════════════════════════════

comment on column comp.payroll_transaction.employee_in_file is
  'El nombre como venia en el archivo de Compensafe, en "Apellido, Nombre". ⚠ ES EL CAMPO POR EL QUE SE EMPAREJA, no person_name: es el mismo formato que finance_division.pl_transactions.check_description y que comp.loan_commission.lo_name, asi que el mismo emparejador --parseDescription + matchDescription en lib/lo-payroll-name.ts-- sirve para los tres lados y las tres fuentes caen sobre la misma persona. Con dos emparejadores distintos, la comparacion entre Compensafe y el P&L enfrentaria a dos personas parecidas y su diferencia no significaria nada.';

comment on column comp.payroll_transaction.pay_date is
  'La fecha en que se PAGO. ⚠ ES LA QUE ACOTA EL PERIODO, no effective_date: una linea con fecha de cierre vieja puede pagarse hoy --Jorge Zuzunaga recupero cuatro periodos de 2025 el 2025-11-14-- asi que acotar por la fecha de cierre se dejaria fuera filas que el archivo de esa quincena si traia. Ver el comentario de effective_date para la otra cara: comparar contra el P&L por el mismo calendario.';

comment on column comp.payroll_transaction.hours_period_from is
  'Inicio del periodo de horas, EXTRAIDO DEL TEXTO de description con el patron "Hours entered from M.D.YY to M.D.YY". No existe como columna en el origen. ⚠ PUEDE SER NULL sin que sea un error: solo las lineas de horas lo llevan, y ni todas -- son 4 de 738 las que traen una descripcion fuera del patron. Una columna que puede faltar no puede ser clave, y por eso txn_key lleva el texto entero y no el periodo.';

comment on column comp.payroll_transaction.hours_period_to is
  'Fin del periodo de horas. Ver hours_period_from: sale del mismo texto, con la misma extraccion, y puede faltar por la misma razon.';

comment on column comp.payroll_transaction.synced_at is
  'La marca de la corrida que escribio esta fila. ⚠ QUE TODA LA TABLA TENGA EL MISMO VALOR NO SIGNIFICA QUE EL ORIGEN SE RECARGUE ENTERO -- esa inferencia se hizo y era falsa. El job estampa la marca de la corrida en CADA fila que escribe (un DEFAULT now() no se dispararia en un UPDATE), asi que sale uniforme aunque Compensafe traiga una sola linea nueva. Y Compensafe SI carga incremental: el 2026-09-16 trajo 49 filas de un solo corte de pago. Lo que mantiene el espejo completo es que la VISTA acumula y el job la lee entera cada vez.';

comment on column comp.payroll_transaction.person_code is
  'El person_code de RRHH, resuelto por el mart. ⚠ NULO EN EL 22% DE LAS FILAS, y por eso la identidad de esta tabla es emp_no y no esto. Las que faltan son justo las de quien no esta dado de alta en RRHH, que es la gente por la que se pregunta. Ver tambien unmatched_person, que NO es lo mismo: uno es el veredicto del mart y el otro la ausencia de un dato.';

comment on column comp.payroll_transaction.loan_amount is
  'El importe del prestamo tal como lo vio Compensafe al calcular esta linea. Junto a amount permite recalcular bps, que por eso es redundante -- ver el comentario de esa columna.';

comment on column comp.payroll_transaction.adj_type is
  'Tipo de ajuste. No entra en la clave: añadirlo da tambien 1.859 sobre 1.859, o sea que no distingue ninguna fila. Es donde se ve que las 196 lineas de sueldo son "Base  Salary" (190) y "Current Salary" (6).';

comment on column comp.payroll_transaction.plan_name is
  'El plan de compensacion, crudo. ⚠ NO SIGNIFICA NADA SIN scenario: el lead source es DERIVADO del par, y "Base Plan" aparece cuatro veces por persona significando cosas distintas. La interpretacion vive en comp_marts.mart_lead_source_check, no aqui.';

comment on column comp.payroll_transaction.scenario is
  'El escenario del plan, crudo. Se lee junto a plan_name -- ver el comentario de esa columna. No entra en la clave: añadirlo da tambien 1.859.';

comment on column comp.payroll_transaction.branch_code is
  'La sucursal de la PERSONA. ⚠ NO ES loan_branch_code, que es la del PRESTAMO, y el P&L por Loan Officer depende de esa diferencia: la escalera restringe el revenue de cada prestamo a su propia sucursal. Donde las dos no coinciden estan las siete sucursales con prestamos y sin nadie en el roster. Ver lib/loan-branch.ts de homesi-pl.';

comment on column comp.payroll_transaction.person_name is
  'El nombre ya resuelto por el mart. Para emparejar se usa employee_in_file, no este -- ver el comentario de aquel.';
