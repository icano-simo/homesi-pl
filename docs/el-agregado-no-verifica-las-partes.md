# Comprobar un total no comprueba sus partes

Compañero de [`notas-que-dependen-del-alcance.md`](./notas-que-dependen-del-alcance.md)
y de [`un-fallo-arreglado-vuelve-por-el-siguiente-camino.md`](./un-fallo-arreglado-vuelve-por-el-siguiente-camino.md).
Aquella trata de mediciones que **caducan** al cambiar el alcance; ésta, de
mediciones que **nunca fueron suficientes**, aunque el número saliera bien.

> ⚠ **El síntoma es que el número cuadra.** Se verifica el total, sale exacto,
> se da por bueno — y el reparto de ese total entre sus filas está mal. El
> agregado no lo dice, porque sumar los errores los cancela.

El documento empezó con ese caso y ha acabado recogiendo **tres formas de que
una comprobación no pruebe lo que parece**, cada una encontrada por las bravas:

| | qué pasa | el engaño |
|---|---|---|
| el agregado **no basta** | el total cuadra y el reparto está mal | el número exacto |
| el agregado **impide** | el dato está por encima del grano de la pregunta | «no lo encuentro» |
| la comprobación **no corre** | un guardia responde antes que el código | un 401 que parece buena señal |

---

## La regla

**Verificar un agregado no verifica sus componentes.** Si lo que se construye
son filas, hay que comprobar **filas**; si el usuario mira un mes, hay que
comprobar **ese mes**.

Y la parte que cuesta: **hay que ejecutar con el corte que usa el usuario, no
con el que es cómodo de medir.** El corte cómodo suele ser el periodo entero,
porque es el que hace que los totales cuadren de un vistazo — y es justo el que
esconde este error.

---

## El caso que lo enseñó

La fila que saca de la cuenta `60105` la comisión de los préstamos de Affinity,
en la lente de «716 puro».

**Lo que se verificó:** el total del ajuste, `20.363,79`, y la cuenta resultante,
`-291.803,96 + 20.363,79 = -271.440,17`. Exacto, ejecutando la ruta contra la
base, con el periodo completo.

**Lo que estaba mal:** el código ponía

```ts
month: rawTxs[0]?.month
```

o sea el ajuste **entero en el mes de la primera transacción del payload**, uno
cualquiera. Ese mes salía inflado en 20.363,79 y los otros ocho a cero.

**Cómo se vio:** el usuario abrió **julio de 2026** y la fila estaba a `0,00`.
No hay ninguna vista del periodo completo en la que eso se note.

**Lo correcto**, una fila por mes:

```
ene 7.663,79 · feb 600 · mar 1.200 · abr 2.400 · may 1.500
jun 2.000 · jul 1.000 · ago 2.000 · sep 2.000      suma 20.363,79
```

---

## Por qué merece un documento

En la sesión que produjo esta funcionalidad se verificaron **decenas** de
totales ejecutando las rutas contra la base: particiones que sumaban al céntimo
(1.828 + 379 = 2.207 filas), conteos que cuadraban (62 + 39 = 101), desgloses
que reconstruían su cuenta (269.790,66 + 95.363,06 − 78.133,90 + 4.784,14 =
291.803,96), y la comprobación de que nada se contaba dos veces.

**Éste fue el primero que estaba bien por fuera y mal por dentro.** Todo lo
demás que falló en esa sesión —un selector que no recargaba, un doble conteo de
65 + 55 = 120, una comisión de 399 préstamos bajo el rótulo de 39, diecisiete
personas que eran seis— se cayó en cuanto se ejecutó. Éste sobrevivió a
ejecutarlo, porque se ejecutó con el corte equivocado.

---

## La otra dirección: el agregado **impide** verificar la parte

El caso de arriba es el agregado que *no basta* para verificar. Existe el
simétrico, y apareció el 2026-09-18: el agregado que **hace imposible** ver la
parte, de modo que no encontrarla no significa nada.

**La pregunta:** ¿el bono de esta persona está dentro de su cuenta de producción?

**La comprobación que parecía obvia** —y que hice primero— era buscar el importe
exacto del bono entre las filas de `60105/60115/60117` de esa persona. Salió
**1 dentro y 17 «no aparece»**.

**Los 17 no estaban medidos.** Las filas del P&L son **agregados mensuales por
persona**: un bono pagado en un mes que también tiene comisión viaja *dentro*
del total de ese mes y no existe como fila propia. Buscar su importe sólo puede
**probar presencia, nunca ausencia**.

> ⚠ **El test asimétrico.** Cuando el dato está agregado por encima del grano de
> la pregunta, encontrar algo es prueba y no encontrarlo no es nada. Un
> resultado negativo de un test así no es un hallazgo: es la ausencia de
> hallazgo, y escribirlo como «no está» lo convierte en una afirmación falsa.

**Por qué los dos casos limpios se dejaron ver:** Matthew Gomez Bruckner y July
Castro tienen **cero cierres**, así que su bono **es toda su nómina** y su fila
del mes es el bono y nada más. No se vieron porque el test funcionara, sino
porque en ellos el agregado y la parte coinciden.

**Lo que sí decide**, y es lo que quedó en `lib/payroll-categories.ts`: la
**reconciliación** del total. Si lo pagado en esas cuentas cuadra al céntimo
*con* el bono, está dentro; si cuadra *sin* él, está fuera; y si no cuadra de
ninguna de las dos, **no se sabe** — y entonces la pantalla no lo afirma. De 27
personas: 3 dentro, 2 fuera, 15 indeterminadas, 7 sin cuentas.

**Lo que costaba:** la etiqueta decía `PAID, BUT NOT IN THESE ACCOUNTS`, que es
una afirmación sobre **cada** caso y era falsa en cuatro. Ahora dice
`PAID, NOT INCLUDED IN THIS COMPARISON`, que es cierto siempre.

**La regla que queda:** antes de escribir un test de ausencia, preguntar a qué
grano está el dato. Si está por encima del grano de la pregunta, el test no
puede contestarla en la dirección negativa — y el número que devuelve es
plausible, alarmante y vacío a la vez.

---

## La tercera forma: la comprobación que no llegó a ejecutarse

Las dos de arriba son mediciones que **no prueban lo que parecen**. Ésta no es
una medición: es una que **nunca corrió**, y se leyó como si hubiera pasado.

**El caso, 2026-09-21.** Dos rutas nuevas se verificaron ejecutándolas desde un
script. Devolvieron esto:

```
manual-vs-rule -> 401 {"error":"Not authenticated"}
impact         -> 401 {"error":"Not authenticated"}
```

Se leyó como *«correcto: van detrás de sesión, como el resto»* — que es cierto —
y se dio la verificación por hecha. **Pero el 401 sale de `requireSession()`, en
la primera línea del handler.** La consulta nunca se ejecutó.

Dentro había un `select` de **`assigned_at`, una columna que no existe**: se
había quitado de la migración al descubrir que `updated_at` ya era esa fecha.
PostgREST no devuelve null ante una columna que falta — devuelve un error que
tumba el `select` entero. La pestaña habría caído completa en producción, y el
único aviso previo había sido un 401 que parecía una buena noticia.

> ⚠ **Un guardia que responde antes que el código no es una comprobación: es
> una pantalla delante de ella.** 401, 403, un `early return`, un `if` de
> permisos, un feature flag apagado, un `catch` que traga — todos devuelven algo
> plausible sin haber tocado lo que se quería probar. Y lo que devuelven se
> parece más a «bien» que a «no se ha mirado».

**Lo que sí lo encontró:** ejecutar la consulta **suelta contra el esquema
real**, con el mismo `select` que usa la ruta, sin pasar por el handler.

```
select de manual-vs-rule: OK, 5 filas
select de impact:         OK
```

**La regla:** una comprobación tiene que decir *qué llegó a tocar*. Si el
resultado es compatible con «no se ejecutó nada», no es un resultado. Y cuando
el guardia es inevitable —una ruta con sesión, desde un script que no la
tiene— hay que bajar un nivel y probar la pieza de dentro: la consulta, la
función, el predicado.

---

## Qué hacer

1. **Comprobar el total Y su reparto.** Si la cifra se va a pintar por mes, por
   sucursal o por persona, la comprobación tiene que salir por mes, por sucursal
   o por persona.
2. **Ejecutar con el corte del usuario.** Un mes concreto, una sucursal
   concreta, la lente que tenga puesta. El periodo entero es el control, no la
   prueba.
3. **Sospechar de las constantes que no dependen de la fila.** Un `[0]`, un
   `?? null`, un valor sacado fuera del bucle: si un campo de una fila no
   depende de esa fila, casi siempre es el error.
4. **Que el total siga cuadrando no es evidencia.** Es la condición mínima.
5. **Antes de un test de ausencia, mirar el grano del dato.** Si está agregado
   por encima de la pregunta, «no lo encuentro» no es un resultado.
6. **Preguntarse qué llegó a ejecutarse.** Si la respuesta es compatible con
   «no se tocó nada» —un 401, un flag apagado, una lista vacía porque el filtro
   no casó— hay que bajar un nivel y probar la pieza de dentro.

---

## Apéndice: una trampa de fecha del mismo arreglo

Al repartir por mes hay que sacar el mes de `pay_date`, y **no con `Date`**:

```ts
new Date("2026-07-31")   // UTC → en un huso al oeste, 30 de junio
```

Las fechas de pago de Compensafe caen a fin de quincena y a fin de mes, o sea
**justo en la frontera**, así que el error no sería ocasional: movería de mes
sistemáticamente las líneas de fin de mes. Se parte el texto:

```ts
MONTH_NAMES[Number(String(pay_date).slice(5, 7)) - 1]
```

Es la misma familia que el resto del documento: un fallo que no rompe nada, no
avisa, y sólo se ve si se mira el mes concreto.
