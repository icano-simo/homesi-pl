# Notas que dependen del alcance, y por eso caducan sin avisar

> Compañero: [`el-agregado-no-verifica-las-partes.md`](./el-agregado-no-verifica-las-partes.md).
> Aquí, mediciones que **caducan** al cambiar el alcance. Allí, mediciones que
> **nunca fueron suficientes** aunque el número saliera bien — comprobar un
> total no comprueba su reparto.

Este proyecto mide antes de decidir y deja la medición escrita al lado del
código. Eso funciona — hasta que alguien cambia **el alcance sobre el que se
midió** y la nota se queda igual.

> ⚠ **El síntoma es que no hay síntoma.** El comentario sigue ahí, sigue
> sonando razonable, y nadie lo revisa porque nada falla. La cifra que cita es
> correcta para la regla vieja y falsa para la nueva.

No es un problema de escribir de más: es que una medición **no es un hecho
absoluto, es un hecho relativo a un alcance**. Cuando la nota no dice cuál era
ese alcance, no hay forma de saber que ha caducado.

---

## La regla

**Toda cifra medida se escribe con el alcance sobre el que se midió.** Y cuando
el alcance es justo lo que puede cambiar, se escriben **las dos columnas**.

Mal:

```
70100 Marketing son 270 lineas que suman EXACTAMENTE 0,00,
asi que incluirlas no cambia ningun total.
```

Bien:

```
                         todas las sucursales   solo la suya
  70100 Marketing                      0,00     -63.737,50
  60125 Operations Payroll             0,00      -1.800,00
  61200 Office Expense            -8.721,60           NULO
```

Con las dos columnas delante, el día que el alcance cambie se ve de un vistazo
cuál de las dos pasa a mandar. Con una sola, la nota miente en silencio.

---

## Los casos que lo enseñaron

### `otherBooked` — "casi siempre vale cero"

**Medido:** el neto de SG&A y Personnel por préstamo daba 0,00 en 270 líneas de
`70100 Marketing` y 24 de `60125 Operations Payroll`.

**Por qué era cierto:** son **pares de traslado** — +640 en una sucursal y −640
en otra. Sumadas las dos sucursales, se anulan.

**Qué cambió:** el peldaño pasó a restringirse a la sucursal del préstamo. Solo
queda **una de las dos patas**, así que ya no se anula nada.

**Lo que la nota decía valer cero valía −63.737,50.** Y al revés con `61200
Office Expense`, que está entero en otra sucursal: desaparece del peldaño y
aparece en "Distributed to division (700)".

Lo detectó el usuario **mirando la pantalla**: `Produced 15.135,35` contra
`Branch gross revenue 16.157,44` en la misma tarjeta. La diferencia eran los
−957,09 de Marketing.

### `org.roster_override` — a quién cubre

Citado en [`lib/loan-source.ts`](../lib/loan-source.ts). Misma forma: una lista
medida sobre una población que después se redefinió.

### El aviso de sucursal del módulo de LO

Decía *"el coste es entero, la producción es solo de esta sucursal"*. Era
exacto mientras la sucursal acotaba los **cierres**. Desde que acota las
**personas** —por `roster_current.branch_code`— las dos mitades son de la misma
persona entera, y el texto decía justo lo contrario de lo que pasaba.

---

## Qué hacer al cambiar un alcance

Cambiar un alcance es cambiar el significado de todo lo medido debajo. Antes de
dar por hecho un cambio así:

1. **Buscar las mediciones que lo tocan.** `grep` por la cifra, no por el
   concepto: las notas citan números.
2. **Re-medir con el alcance nuevo**, aunque "obviamente" no cambie. En
   `70100 Marketing` el cambio fue de 0,00 a 63.737,50.
3. **Dejar las dos cifras**, la vieja y la nueva, con el alcance de cada una.
   Una nota corregida que borra la anterior pierde justo la información que
   explica por qué alguien creyó lo otro.
4. **Comprobar que lo que sale de un sitio entra en otro.** El Office Expense
   no se perdió: salió del peldaño y entró en la sección de la 700. Eso se
   verifica ejecutando, no leyendo.
