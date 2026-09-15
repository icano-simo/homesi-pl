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

### `feature/lo-commission-in-pl` — **viva, NO borrar**

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
