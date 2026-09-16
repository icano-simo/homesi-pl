# Ramas retiradas, y por qué

Registro de ramas que se borraron sin mergear. Existe para que nadie las eche
de menos sin saber qué llevaban dentro, y para que nadie intente recuperarlas
por el camino equivocado.

> ⚠ **Ninguna de estas se puede mergear tal cual.** Quedaron tan atrás de `main`
> que un merge directo *borraría* trabajo posterior. Si algo de aquí hace falta,
> se recupera por `cherry-pick` o se reescribe — nunca por merge.

---

## `feature/lo-pnl-and-loan-fixes` — borrada el 2026-09-15

**Estado al borrarla:** 5 commits por delante de `main`, **33 por detrás**.
Último commit del 2026-09-12.

**Tres de sus cinco commits ya estaban en `main`** con otro SHA, así que su
contenido entró por otro camino:

| Commit | Dónde está |
|---|---|
| `feat(settings): el filtro de sucursal es de cada uno, y las notas tienen autor` | en `main` (`55d08ec`) |
| `fix(loans): el margen tambien se cobra en RM, y 15 prestamos lo tenian` | en `main` |
| `fix(loans): el bps medía una comisión fija, y julio no tenía la culpa` | en `main` |

**Los otros dos están superados:**

- `feat(loans): mini P&L por Loan Officer, y nadie sale valiendo cero` — es el
  antecesor del módulo actual. Su pantalla, `app/loan-officers/page.tsx`, ya no
  existe en ninguna rama viva; la sustituye `app/lo-pnl/page.tsx`. Y su
  emparejador, `lib/lo-payroll-match.ts`, es el antecesor de
  `lib/lo-payroll-name.ts`: mismo problema, mismos ejemplos
  (`"LAINO CHEGWIN, GIAN L"`, `"CASTRO, JULY M"`), y el nuevo es sobre el que se
  construyó todo lo demás.
- `fix(migration): sin politica y sin GRANT redundante, y la errata queda dicha`
  — arregla la migración `20260827_lo_payroll_aliases.sql`, y esa tabla **se
  elimina** en `20260914_drop_lo_payroll_aliases.sql`. Arreglar una tabla que se
  va a borrar no aporta nada.

**Por qué no se podía mergear:** su diff contra `main` *quitaba*
`lib/loan-source.ts` (−447 líneas), `lib/loan-validation-filters.ts` (−225), la
normalización de sucursal de Blast en `lib/normalize-pl.ts`, y el `package.json`
con `xlsx` desde el CDN de SheetJS. Todo trabajo posterior.

---

## Ramas vivas, para no repetir el problema

**Regla:** una rama a medias más de un día, o se mergea o se anota aquí y se
borra. Cuatro ramas sueltas es como se llegó a tener una 33 commits atrás.

### `feature/lo-commission-in-pl` — ⚠ YA NO: borrada el 2026-09-16

> **Esto dejó de ser cierto.** Su contenido SÍ llegó por otra vía —el mini P&L
> pasó a restar la comisión el 2026-09-16— y la rama se borró. El registro de
> la retirada, con lo que se conservó y lo que se revirtió, está al final de
> este documento. Lo de abajo se deja tal cual se escribió, porque es el
> razonamiento que la mantuvo viva y explica por qué acabó absorbida.

2 commits, ninguno en `main`, y **su contenido no llegó por otra vía**:
`app/api/loan-detail/route.ts` en `main` no menciona la comisión ni una vez, y
el drawer tampoco. En `main`, `comp.loan_commission` solo la leen
`loan-validation` y el módulo de LO.

Lo que hace: enseña en el **modal de detalle de préstamos** cuánto se le pagó al
loan officer por cada préstamo y qué queda después.

    neto = (revenue − lo contabilizado en la 700) − lo_pay

⚠ **No lo cubre el módulo de P&L por Loan Officer, y no es un descuido de
ninguno de los dos: responden preguntas distintas.**

| | Pregunta | Qué hace con la comisión |
|---|---|---|
| Módulo de LO | ¿esta *persona* se paga sola? | **No la resta** — sale por la nómina, restarla y contar 60105 la contaría dos veces |
| Esta rama | ¿este *préstamo* dejó algo a la sucursal? | **Sí la resta** — contra el revenue de la sucursal, no el entero |

Decisiones suyas que conviene no perder:

- **`lo_pay`, nunca `total_pay`.** `total_pay` incluye `other_pay`, que es el
  *override* y se le paga al manager del LO — las líneas del origen lo dicen
  literalmente (`"BR 770 - Override on Badovinac"`). Sumarlo atribuiría el pago
  de uno a otro.
- **El neto se calcula sobre el revenue FILTRADO**, para que se reconstruya de
  los dos números que tiene al lado. Con filtro de sucursal activo eso da
  negativos en préstamos que no pierden dinero (8 sin filtro contra 83
  restringiendo cada préstamo a la suya), y la solución es **decirlo** junto a
  "Banked loans only", no esconderlo en un tooltip.
- **No intenta detectar "P&L incompleto".** Salen 47 negativos de 270 y se
  muestran tal cual; cuando se cargue el margen que falta se corrigen solos. Un
  código que hubiera intentado distinguir "pérdida real" de "margen sin cargar"
  habría tenido que desaprenderlo.

**Está 28 commits por detrás de `main`**, así que la recuperación es por
`cherry-pick` o reescritura. Y el sitio natural es el modal de detalle — que es
exactamente donde va a vivir la pestaña del P&L por Loan Officer, así que las
dos cosas se pueden pensar juntas.

---

## `feature/lo-commission-in-pl` — borrada el 2026-09-16

**Estado al borrarla:** 2 commits por delante de `main`, **31 por detrás**.

Esta es la rama que el registro anterior marcaba como **«viva, NO borrar»**. Se
borra porque su contenido ya está absorbido, no porque se descarte: lo que hacía
—restar la comisión del loan officer en el mini P&L del P&L por sucursal— es
exactamente lo que se implementó el 2026-09-16, por decisión del usuario, en
`app/api/loan-detail/route.ts` y `components/loan-pnl-card.tsx`.

### Qué de la rama está cubierto

| Lo suyo | Dónde está ahora |
|---|---|
| `lo_pay` por préstamo, de `comp.loan_commission` | `LoanDetailRow.commission` |
| El neto después de la comisión | `LoanDetailRow.contribution`, y el banner `TOTAL CONTRIBUTION` |
| `createServerClient(schema)` para leer `comp` | ya estaba en `main` |
| «No intenta detectar P&L incompleto» | **se hace lo contrario, y medido**: ver abajo |

Sus tres decisiones se conservan, y las tres viven hoy en el código:

- **`lo_pay`, nunca `total_pay`**, porque `total_pay` incluye el *override* que
  se le paga al manager del LO. Escrito en la nota de `commissionByLoan`.
- **El neto se reconstruye de los dos números que tiene al lado.** Por eso `net`
  siguió siendo revenue + costes directos y la contribución es un campo APARTE:
  la tabla deriva «Other revenue» como `net − margin_net`, y meter la comisión
  dentro de `net` la habría escondido ahí en silencio.
- **Decirlo, no esconderlo.** La comisión lleva en pantalla «from Compensafe —
  not a P&L account», porque no tiene `gl_code` y no cuadra contra el libro
  mayor como el resto de la tarjeta.

### La decisión que SÍ se revierte, y por qué

La rama decía: *«No intenta detectar "P&L incompleto". Salen 47 negativos de 270
y se muestran tal cual; cuando se cargue el margen que falta se corrigen solos.»*

Medido el 2026-09-16, eso no aguanta: de los **13 préstamos que pasan a negativo**
al restar la comisión, **NUEVE cerraron en septiembre de 2026 y no tienen ni una
línea de P&L**. Compensafe ya pagó y el margen no se ha contabilizado. Uno sale a
−11.488,07 y lo único que pasa es que falta cargar el mes.

Nueve de trece no es ruido de fondo: es la mayoría del hallazgo, y presentado
«tal cual» dice que esos préstamos perdieron dinero. Llevan marca `P&L pending`.

### Lo único suyo que NO se trae, y es deliberado

`corporate_revenue` / `branch_revenue` — el reparto entre lo que se queda
corporativo y lo que se queda la sucursal. Existe hoy, pero **solo en el módulo
de P&L por Loan Officer**, como la sección «Not part of this branch's
contribution». Que el mini P&L del P&L por sucursal NO la lleve es una decisión
del usuario del 2026-09-16, no un olvido: esa pantalla cierra su cuenta en
`TOTAL CONTRIBUTION` y el reparto con la 700 es contexto del otro módulo.

También queda fuera `lo_effective_bps`, un campo de Compensafe que ninguna
pantalla enseña.
