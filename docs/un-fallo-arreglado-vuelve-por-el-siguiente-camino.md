# Un fallo arreglado en un camino vuelve por el siguiente

Compañero de [`el-agregado-no-verifica-las-partes.md`](./el-agregado-no-verifica-las-partes.md)
y de [`notas-que-dependen-del-alcance.md`](./notas-que-dependen-del-alcance.md).

> ⚠ **El síntoma es un comentario que dice «arreglado».** El código explica con
> detalle un fallo que ya se corrigió, y el mismo fallo está ocurriendo dos
> líneas más abajo — porque llega por otra puerta. El comentario no miente
> sobre lo que arregló; miente por omisión sobre lo que no.

---

## El caso que lo enseñó

**La comisión de la división entera bajo el rótulo de Affinity.**

`app/api/loan-metrics/route.ts` lleva una nota escrita al arreglarlo la primera
vez:

> ⚠ `inScope`, NO `rows` A SECAS. `fetchOfficials` **NO** aplica el filtro de
> sucursal, así que `rows` son los cierres de toda la división. Sin este filtro
> la comisión salía **952.168,48 en 399 préstamos** donde tenían que ser
> **20.863,79 en 39**: el número de la división entera bajo el rótulo de
> Affinity.

Arreglado, medido y documentado. Y sin embargo, el **2026-09-21**, con la 700
seleccionada y la lente de Affinity puesta, la misma cifra volvía a salir:

```
branch=700 + lente Affinity   795.350,78 en 323 préstamos
branch=716 + lente Affinity    13.800,00 en  32     <- lo real
```

**El mismo fallo. Por otra puerta.**

| | cómo entraba |
|---|---|
| **la primera vez** | `fetchOfficials` no aplicaba el filtro de sucursal |
| **la segunda** | `resolveBaseBranches` devuelve `null` con la 700 — la regla corporativa, que es **correcta** para el bps — y `inScope` acepta todo |

El arreglo de la primera vez seguía funcionando perfectamente. Simplemente no
cubría la segunda entrada, que nadie había abierto todavía cuando se escribió.

---

## Otras dos veces en la misma sesión

1. **La lente de Affinity olvidada.** Se arregló en el endpoint de métricas, y
   volvió en la rejilla, en el loan count, en el drawer y en el módulo por loan
   officer. El tipo `AffinityLens` acabó documentando **cinco formas** distintas
   del mismo olvido. Ninguna era un descuido: cada consumidor nuevo era una
   puerta nueva.
2. **La comisión donde no se cierra.** Se arregló en el módulo por loan officer
   (`hasCommission`, PR #11) preguntando si había líneas de comisión para esas
   *personas*. Volvió en Mini P&L Cards y en Table List, donde el cruce es por
   *préstamo* y no por persona (PR #12).

---

## Qué hacer

1. **Un comentario que dice «arreglado» es una lista de sospechosos, no un
   certificado.** Nombra un fallo que este código sabe cometer. Preguntar por
   qué otros caminos podría llegar cuesta menos que volver a encontrarlo.
2. **Arreglar en la función compartida, no en el sitio donde se vio.**
   `hayCierresPropios` vive en `lib/loan-branch.ts` y no dentro de la ruta: la
   segunda puerta se cierra sola.
3. **Al arreglar algo con alcance, barrer la pantalla entera con ese alcance
   puesto.** El barrido de la 700 encontró tres superficies más y una cuarta que
   nadie había pedido — la peor de las cuatro.
4. **Escribir la puerta, no solo el arreglo.** «Entraba por `fetchOfficials`» y
   «entraba por la regla corporativa» son dos hechos distintos, y el segundo no
   se deduce del primero.

---

## Por qué esta familia es difícil de ver

El arreglo original **funciona**. No hay regresión: los tests que hubiera
seguirían en verde, la medición que lo validó sigue dando el número bueno, y el
comentario sigue siendo cierto. Lo que cambió es que existe un camino nuevo
hasta el mismo sitio.

Por eso no se detecta releyendo el arreglo. Se detecta preguntando **quién más
llega hasta aquí**.
