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

## La versión más simple: reglas hermanas

No hace falta que el segundo camino sea exótico. El **2026-09-21**, tres reglas
partían el mismo margen en tres destinos:

```
Income: Override margin     (41309 OR 41307) AND recruitment=no AND b2b=no  -> CC01
B2B income                   41309           AND b2b=yes AND branch=700     -> CC03
Recruitment income           41309           AND recruitment=yes            -> CC04
```

Alguien vio que faltaba margen en CC03, se midió, y se arregló **la de B2B**.
Las otras dos quedaron con la forma vieja. La de Recruitment **no se vio hasta
que el usuario preguntó expresamente por ella** — y tenía el mismo hueco: 2
filas, 2.130,70.

> ⚠ **Cuando algo tiene hermanas, el arreglo no es de una: es de la familia.**
> Reglas que parten el mismo dato, rutas que leen la misma tabla, pantallas que
> hacen la misma pregunta. Arreglar la que se ve fallar deja a las demás
> esperando a que alguien las mire.

**Lo que cierra el caso es el barrido, y hay que dejarlo medido.** Aquí:
ninguna otra regla de `cost_center_rules` ni de `split_rule_conditions` usa
`b2b`, `recruitment`, `processing`, `support_on_demand`, `affinity`,
`lead_source_lo` ni `bd_owner`. Son exactamente esas tres — por eso se puede
decir que está completo en vez de esperar a la siguiente.

*(Y el barrido hay que hacerlo en **las dos** tablas. La primera medición miró
sólo `cost_center_rules`, dio cero, y concluyó que ninguna regla usaba esos
campos. Las cuatro que sí los usaban estaban en `split_rule_conditions`.)*

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
4. **Si tiene hermanas, arreglar la familia** — y decir cuántas son y cómo se
   contaron, para poder dar el barrido por cerrado.
5. **Escribir la puerta, no solo el arreglo.** «Entraba por `fetchOfficials`» y
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
