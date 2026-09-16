# Contrato de sync: `comp_marts.fct_payroll_transaction` → `comp.payroll_transaction`

> **El spec ya está escrito**, en `simo-sync`, `app/api/sync/route.ts`, junto a
> los de `fct_loan_commission` y `hours_logged`. Esto es el resumen del
> contrato, para tenerlo del lado que lo consume.
>
> ⚠ **Y una cosa que este documento decía mal.** Decía que `txn_key` se
> construye en el sync. **No: se construye arriba, en una vista de BigQuery**,
> igual que `hours_key` — ver §2. El precedente de `hours_logged_v` es
> explícito sobre por qué, y no lo había visto al escribir esto.

Vive en este repositorio, y no en `simo-sync`, porque la app depende de este
mapeo: el día que una columna cambie de significado al otro lado, esto es lo
que dice qué se rompe aquí.

---

## 1. El destino

`comp.payroll_transaction`, aplicada el 2026-09-16
(`20260916213743`). Su definición y **todas las decisiones, con sus
mediciones**, están en
[`supabase/migrations/20260916_comp_payroll_transaction.sql`](../supabase/migrations/20260916_comp_payroll_transaction.sql).
No se repiten aquí: si las dos copias se separan, gana la migración.

⚠ Con el rename de
[`20260916_comp_payroll_transaction_rename_description.sql`](../supabase/migrations/20260916_comp_payroll_transaction_rename_description.sql)
aplicado, la columna se llama `description`, no `check_description`.

## 2. La clave, y dónde se calcula

```
txn_key = emp_no | pay_date | pay_type | loan_number | description | amount
```

Medido: **1.859 valores distintos sobre 1.859 filas.** El origen no trae
ninguna columna que sirva de clave propia.

⚠ **Se calcula en una vista de BigQuery, `comp_marts.fct_payroll_transaction_v`,
que todavía no existe.** Ése es el bloqueo del paso 3: el spec está escrito y
apunta a ella. El precedente es `hours_logged_v`, y su razón está escrita allí:
una clave calculada en el job existiría solo en Supabase —no se podría joinear
desde BigQuery ni comprobar un invariante sobre ella— y **podría divergir de sí
misma**. Si alguien cambiara cómo se compone, las filas viejas quedarían con la
clave vieja, el upsert dejaría de encontrarlas e insertaría duplicados en vez de
actualizar.

⚠ **El `COALESCE` no es defensivo, es lo que hace que funcione.** Misma lección
que `hours_logged_v`, y aquí pega mucho más fuerte: allá fallaban 4 filas de 731
por una descripción rara; aquí **`loan_number` es nulo en la mayoría de las
líneas** —Bonus, las horas, todo lo que no es comisión—. Concatenar un `NULL` da
`NULL` en toda la expresión, así que sin `COALESCE` la clave sería nula en más de
la mitad de la tabla.

⚠ **Sin ordinal.** Un `ROW_NUMBER()` habría hecho la clave única por
construcción, pero solo aguanta mientras la carga sea completa. Esta aguanta
las dos.

⚠ **Y ninguna combinación más corta vale** — el porqué, con los números, está
en la migración. Resumen: Jorge Zuzunaga tiene seis líneas el 2025-11-14, una
persona y una fecha de pago.

El separador tiene que ser un carácter que no aparezca en ningún campo. `|`
vale para `emp_no`, las fechas, `pay_type` y `amount`; **`description` es texto
libre y hay que comprobarlo**, porque un `|` dentro de una descripción movería
el troceo y dos filas distintas podrían producir la misma clave. Si aparece, se
escapa o se usa un hash.

## 3. El mapeo

| Origen (`fct_payroll_transaction`) | Destino (`comp.payroll_transaction`) | Nota |
|---|---|---|
| `emp_no` | `emp_no` **not null** | la identidad; nunca `person_code` |
| `person_code` | `person_code` | nulo en ~22% de las líneas |
| `person_name` | `person_name` | |
| `employee_in_file` | `employee_in_file` | la grafía cruda |
| `unmatched_person` | `unmatched_person` **not null** | ⚠ ver §4.3 |
| `hr_position` | `hr_position` | gana el roster cuando los dos hablan |
| `branch_code` | `branch_code` | la sucursal de la **persona** |
| `loan_number` | `loan_number` | solo en líneas ligadas a un préstamo |
| `loan_branch_code` | `loan_branch_code` | la sucursal del **préstamo** |
| `loan_amount` | `loan_amount` | |
| `pay_date` | `pay_date` **not null** | |
| `effective_date` | `effective_date` | la fecha de **cierre** |
| — | `hours_period_from` / `_to` | ⚠ derivadas, ver §4.1 |
| `pay_type` | `pay_type` **not null** | |
| **`gl_code_credit`** | **`pay_category`** | ⚠ **renombrada**, ver §4.2 |
| `adj_type` | `adj_type` | |
| `plan_name` | `plan_name` | no significa nada sin `scenario` |
| `scenario` | `scenario` | |
| `is_hourly` | `is_hourly` **not null** | ⚠ esta cuenta las horas, no `pay_category` |
| `is_recapture` | `is_recapture` **not null** | |
| `description` | `description` | ⚠ **NO** `check_description`, ver §4.4 |
| `amount` | `amount` **not null** | con signo |
| — | `synced_at` | el instante del lote |

**No se espejan**, y el motivo de cada una está en la migración: `bps`
(es `amount`/`loan_amount`×10.000, medido en 739 de 739), `debit_credit` (el
signo ya está en `amount`), `borrower`, `loan_branch_name`, `property_state`,
`person_country`.

## 4. Lo que el sync tiene que hacer, y no se ve mirando la tabla

### 4.1 Extraer el periodo de horas del texto

`hours_period_from` y `hours_period_to` **no existen en el origen**: salen de
`description` con el patrón `"Hours entered from M.D.YY to M.D.YY"`.

⚠ **Y fallan a veces, sin que sea un error.** En `comp.hours_logged` son 4 de
731 las que traen una descripción fuera del patrón. El sync **escribe null y
sigue** — nunca tira la fila ni el lote. Una columna que puede faltar no puede
ser clave, y por eso la clave lleva el texto entero.

⚠ **Misma extracción que `hours_logged`, no una nueva.** Si `simo-sync` ya
tiene esa función para el otro spec, se reutiliza. Dos implementaciones del
mismo patrón dan dos periodos distintos el día que aparezca una descripción
rara, y las dos tablas dejarán de cuadrar sin que nada falle.

### 4.2 `gl_code_credit` se escribe en `pay_category`

El nombre del origen promete un código contable y contiene categorías de pago
(`Non-Recoverable Hours`, `Recoverable Salary`…). Se renombra al espejarla.

⚠ **Solo cubre 2026.** Las 311 líneas de horas de 2025 vienen sin categoría
porque Compensafe empezó a clasificar después. El sync **no rellena ese hueco
con nada**: null ahí significa «no consta», y escribir `Non-Recoverable` por
defecto convertiría un no-consta en un no.

### 4.3 `unmatched_person` es `not null`

Si el origen la trae nullable, el sync tiene que decidir qué es null — y la
respuesta no es `false`. Si el mart no dice nada sobre si casó o no, eso no es
«casó bien». Mientras no se sepa, el sync **falla ruidosamente** en vez de
elegir: es la columna que da entrada a los 523.207,01 de nómina sin atribuir, y
un `false` por defecto los haría desaparecer del recuento.

### 4.4 `description` viaja con su nombre, y eso es una decisión

El destino se llamó `check_description` unas horas y se renombró: ese nombre **ya
significa otra cosa** en `finance_division.pl_transactions` — el memo de un
apunte del libro mayor, que leen las reglas de centro de coste, los repartos y
la detección del B2B success fee. Dos campos de dos sistemas con el mismo nombre
acaban en alguien aplicándole a uno una regla escrita para el otro.

⚠ Y se quedó en `description`, el nombre del origen, **en vez de un tercer
nombre propio**: el espejo y la fuente hablan el mismo idioma y el `select` no
traduce nada. Una traducción solo se paga cuando el nombre de origen miente,
como en `pay_category`.

### 4.5 La carga es completa, y la tabla va al barrido

Upsert por `txn_key` más el sweep, como las otras dos de Compensafe —
`comp.payroll_transaction` está en `SWEEPABLE`.

⚠ **Y es la que más lo necesita, por algo que las otras dos no tienen: su clave
incluye `amount` y la descripción.** Corregir un importe arriba no actualiza la
fila — crea una nueva, porque la clave cambió. Sin barrido quedarían las dos, el
pago viejo y el corregido, sumando los dos en la misma persona.

⚠ Si algún día pasa a incremental, **la clave sigue valiendo** — se eligió así
a propósito — pero hay que revisar el borrado: un `delete` por rango de fechas
tiene que usar `pay_date`, no `effective_date`, porque una línea con fecha de
cierre vieja puede pagarse hoy. Zuzunaga recuperó cuatro periodos de 2025 el
2025-11-14.

## 5. Después del primer lote: cuatro comprobaciones

Ninguna es opcional. Las cuatro salen de algo que quedó medido a medias.

1. **1.859 filas y 1.859 `txn_key`.** Si no, el separador de la clave se ha
   encontrado un `|` dentro de una descripción (§2).

2. **`comp.hours_logged` es el subconjunto `is_hourly`, agrupado.** Las dos
   cifras coinciden exactamente —738 filas sobre 815 líneas de origen allí,
   815 líneas `is_hourly` aquí— pero **coincidir no es ser el mismo conjunto**.
   Una consulta que los cruce lo cierra, y hay que hacerla **antes de que
   ninguna pantalla lea las dos tablas**: quien las sume cuenta las horas dos
   veces, y son 1,24 millones.

3. **`amount` llega con signo.** Earnings Recapture tiene que sumar −203.614.
   Si llega en valor absoluto, `debit_credit` deja de ser una columna
   descartable y hay que aplicarla **en el sync antes de escribir** — nunca
   guardarla, para que nadie pueda leer el importe sin ella.

4. **Los cinco `pay_type` y las cuatro `pay_category`** son los de hoy. No hay
   `CHECK` a propósito: si aparece un sexto valor tiene que **verse**, no
   tumbar la carga.

## 6. Lo que esto NO autoriza a hacer en la app

El paso 4 es aparte, y dos cosas concretas necesitan su propia decisión:

- **Comparar por `effective_date` en vez de por `pay_date`.** Es lo mejor que
  trae esta tabla —resuelve el desfase de los dos calendarios, que es por lo
  que solo 7 de 39 officers casan al euro— pero cambiar el eje de la
  comparación cambia lo que significa el número en pantalla. Es una decisión
  con su medición, no un efecto secundario de espejar una columna.

- **Pintar las horas de 2025 como no recuperables.** No se sabe: antes de 2026
  no hay categoría, y la ausencia es un «no consta». La tarjeta puede decir
  cuánto de lo pagado por horas es un adelanto **solo desde 2026**.
