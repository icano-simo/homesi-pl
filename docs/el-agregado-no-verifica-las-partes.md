# Comprobar un total no comprueba sus partes

Compañero de [`notas-que-dependen-del-alcance.md`](./notas-que-dependen-del-alcance.md).
Aquella trata de mediciones que **caducan** al cambiar el alcance; ésta, de
mediciones que **nunca fueron suficientes**, aunque el número saliera bien.

> ⚠ **El síntoma es que el número cuadra.** Se verifica el total, sale exacto,
> se da por bueno — y el reparto de ese total entre sus filas está mal. El
> agregado no lo dice, porque sumar los errores los cancela.

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
