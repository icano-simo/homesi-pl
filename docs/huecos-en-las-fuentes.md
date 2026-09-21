# Huecos en las fuentes

Compañero de [`el-roster-no-registra-bajas.md`](./el-roster-no-registra-bajas.md),
que es uno de estos con documento propio.

> ⚠ **Una fuente puede fallar de tres maneras, y sólo una se ve.** Que no
> exista la columna se nota al escribir la consulta. Que exista y esté vacía,
> o que exista y lleve meses sin actualizarse, no avisa de nada: devuelven un
> valor, y el valor es «no».

Registro de los que se han encontrado, para que el siguiente se busque en vez
de tropezarse.

---

## `finance_division.loan_officials` — parada desde el 2026-08-20

El archivo que se sube a mano. **436 filas** contra **5.114** del espejo.

De aquí salían siete clasificaciones que ahora vienen de fuentes vivas
(`activity_report.loan_records_v2` y `finance_division.loan_manual_flags`).
Lo que costó, medido: `b2b` veía **106** préstamos donde las fuentes vivas ven
**822**, y la regla `b2b = yes → CC03` dejaba caer en CC01 todo lo que la tabla
parada no conocía.

**A 2026-09-21 no le queda ni un lector.** Las menciones que sobreviven en
`lib/reevaluate-rule-assigned.ts` son comentarios.

---

## `is_recruitment` — la columna que no existía

`loan_records_v2` tenía `is_affinity`, `is_b2b`, `is_closed` e
`is_second_lien_heloc`. **No tenía `is_recruitment`**, así que `recruitment`
fue el último campo atrapado en la tabla parada.

**BigQuery tampoco expone `is_b2b`**: el sync la deriva de `strategy`. La misma
puerta servía, sin tocar BigQuery:

```ts
"strategy = 'B2B'         AS is_b2b",
"strategy = 'Recruitment' AS is_recruitment",
```

> ⚠ **Y cambia el modelo, no sólo la fuente.** `strategy` es **un** valor con
> precedencia `Affinity > NPPM > Recruitment > B2B > Own Production`;
> `loan_officials` tenía casillas **independientes** y un préstamo podía llevar
> dos. Quien vuelva a poner casillas independientes reabre la posibilidad de
> que un préstamo case con dos reglas hermanas — que es de donde salían los
> conflictos.

---

## `bd` — cuatro préstamos vacíos en el espejo

Al migrar los siete campos se comprobó cuánto perdía cada uno frente a la tabla
parada:

| campo | destino | pierde |
|---|---|---|
| `affinity` | `is_affinity` | 0 (32 → 32) |
| `lead_source_lo` | `lead_source` | 0 (390) |
| `processing`, `support_on_demand` | `loan_manual_flags` | 0 |
| **`bd_owner`** | **`bd`** | **4** |
| `recruitment` | `strategy` | 1 (ver arriba) |

Los cuatro: **Giovanni Osorio** (760002049108), **Angie Cassiani**
(913002013255), **Samuel Tirado** (700002017412) y **Annie Garrido**
(700002005513). El espejo tiene `bd` vacío y la tabla parada tenía nombre.

**Hoy no cambia nada**: ninguna regla de centro de coste usa `bd_owner`. Se
anota porque es el mismo tipo de hueco, y porque el día que alguien escriba una
regla sobre ese campo, esos cuatro fallarán en silencio.

---

## Qué hacer

1. **Antes de fiarse de un campo, mirar cuándo se actualizó su fuente.** Una
   tabla que se sube a mano tiene fecha de caducidad y no la anuncia.
2. **Comparar la fuente nueva con la vieja en las dos direcciones**, no sólo el
   total. «Gana 716 y pierde 0» es una afirmación distinta de «ahora hay más».
3. **Una columna que falta no siempre hay que pedirla aguas arriba.** `is_b2b`
   no existe en BigQuery y aun así llega: se deriva en el sync. Mirar cómo se
   resolvió la hermana antes de abrir un ticket.
4. **Si la forma del dato cambia — de dos banderas a un valor con precedencia —
   eso es un cambio de modelo.** Escribirlo donde vive el predicado, no sólo en
   el commit.
