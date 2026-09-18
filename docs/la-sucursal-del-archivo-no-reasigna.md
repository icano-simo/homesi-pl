# La sucursal del archivo se enseña, y no se corrige

En el offshore hay **dos** sucursales por fila y no coinciden:

| | qué es | dónde vive |
|---|---|---|
| **Branch** | la sucursal contable, donde está el apunte | `pl_transactions.branch` |
| **Branch (file)** | la que dice el archivo de offshore | `pl_transactions.branch_allocation` |

**Las 981 filas del offshore están contabilizadas en la 700. Todas.** Pero el
archivo dice otra cosa en 204 de ellas.

---

## Lo medido, 2026-09-18

**204 filas por −317.770,35**, repartidas en nueve sucursales:

```
733       -81.455,28   36 filas
716       -71.733,35   52
747       -46.169,05   26
760       -39.014,06   24
Affinity  -38.823,28   29
703       -17.435,45   12
707       -13.491,05   10
724        -7.090,50   12
741        -2.558,33    3
                       ───
                       204 filas
```

Las otras 777: **467** dicen 700 —que coincide con la contable— y **310** no
dicen nada, porque son los vendors y las 15 de `Homesi ... payroll`.

> ⚠ **Affinity se escribe de tres maneras** en esa columna: `Affinity`,
> `Hired by Jim` y `Hired by for Jim`. Las tres son lo mismo y se normalizan a
> una, con la misma regla que el módulo Roster (`lib/roster-file.ts`). Sin
> unificarlas, las cuentas de Affinity salen partidas en dos.

---

## Por qué no se corrige

**Es una decisión, no un pendiente.** Reasignar esas 204 filas movería el P&L
de **nueve sucursales a la vez**, y con él todo lo que cuelga: de las 981 filas
del offshore, **967 tienen centro de coste** y **104 de los 116 grupos tienen
split**, que cubren **941 filas**. El coste de tocarlo no es la reasignación,
es todo lo que se recalcularía detrás.

> Las 941 salen de reconstruir aquí la clave de grupo (`description3` para el
> roster, `vendor` para lo demás). El módulo cuenta 944: la diferencia son tres
> filas donde el nombre del proveedor se normaliza distinto. Se deja el método a
> la vista porque el número exacto depende de él.

Así que la columna **se enseña y no reasigna nada**. Ver dónde difieren es
información; cambiarlo es un proyecto.

---

## Si alguien lo retoma

1. **Es un movimiento entre sucursales, no un gasto nuevo.** Los −317.770,35
   salen de la 700 y entran en las otras nueve. La división no cambia.
2. **Mirar antes qué cuelga de esas filas.** Centros de coste y splits están
   anclados a la fila, no a la sucursal, así que sobreviven — pero el P&L de
   cada una de las nueve cambia el mismo día.
3. **Affinity no es una sucursal contable.** Las otras ocho son códigos que ya
   existen; Affinity es la línea de negocio que la 716 aloja, y eso ya tiene su
   propia lente en el P&L. Reasignar ahí es una pregunta distinta de las otras
   ocho, y merece decidirse aparte.
4. **El archivo no es más cierto que el libro.** Dice quién debería llevar el
   coste, no dónde está. Que difieran es el dato; cuál de los dos manda es una
   decisión de negocio que nadie ha tomado todavía.
