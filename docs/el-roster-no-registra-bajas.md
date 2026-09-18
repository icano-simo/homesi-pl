# El roster de RR.HH. no registra bajas

Medido el **2026-09-18** sobre `org.roster_current`:

| | |
|---|---|
| Personas | **115** |
| Marcadas activas (`is_active`) | **111** |
| Con fecha de salida (`left_detected_at`) | **0** |

**Cero. Ninguna, nunca.** La columna existe y está vacía en las 115 filas.

Mientras tanto, el archivo de nómina offshore enseña **16 personas que dejaron
de cobrar**. Dos están confirmadas por el usuario como salidas —**John Bedoya**
y **Walter Serrano**— y el roster sigue dándolas por activas.

---

## Por eso el estado sale de la nómina

**Quien no cobra, no está.** Es la única fuente que lo sabe.

La regla: una persona del archivo de offshore que **no aparece en el último mes
cargado** queda marcada como baja, con el mes de su último pago.

> ⚠ **El «último mes» se deriva del dato, no se escribe.** Es el máximo período
> que trae el archivo. El día que entre octubre, la regla se mueve sola. Una
> fecha a mano ahí sería una bomba de relojería: seguiría dando por activos a
> los de septiembre para siempre.

### Las 16, por último pago

```
jul 2026   Walter Serrano, Alfredo Padilla
jun        Samuel Tirado, Eric Sánchez, Kyle Silva, José Falquez, Katia Escobar
abr        John Bedoya, Camilo Martínez, Danika Piragua, Gabriel Orozco,
           Johan Urueta
mar        Jorge Zorro, Alejandro Jiménez, Daniel Arévalo
feb        Paola Gómez
```

---

## Dieciséis, no dieciocho — y las dos que sobran enseñan algo

Comparando **texto crudo** salen 18. Dos no lo son:

1. **`New Hire- IT`** no es una persona. Ya está fuera del módulo por otra
   razón, así que tampoco puede salir aquí como una baja.
2. **Jimena Ferrer Gutiérrez** deja de aparecer en junio… pero
   **Jimena Inés Ferrer Gutiérrez** cobra hasta septiembre. Son la misma
   persona (`jimena.ferrer`). **No es una baja: es la misma persona escrita de
   dos maneras.**

> ⚠ **Hay que acumular por persona ya unificada, no por texto.** Contando
> grafías, Jimena sale en la lista de bajas con nombre y apellidos, que es la
> clase de error que nadie va a dudar al leerlo.

*(Y hay una tercera Ferrer Gutiérrez, Danna Camila, que es otra persona y está
activa.)*

---

## Lo que la pantalla no afirma

Tres estados, no dos:

| | quiénes | qué significa |
|---|---|---|
| **Paid `<mes>`** | 53 | cobró en el último mes cargado |
| **Left · last paid `<mes>`** | 16 | está en el archivo y dejó de aparecer |
| **no data** | 70 | no está en el archivo; la regla no le alcanza |

**«Sin dato» no es «activo», y ese tercer estado es lo que hace útil a la
columna.** Las 70 incluyen a las **68 de EE.UU.**, que no aparecen en el archivo
de offshore. Pintarlas activas diría que se comprobó, y no se ha comprobado
nada.

> Es mejor no marcar que marcar mal. Si las 68 salieran como activas sin
> distinción, alguien creería que alguien lo miró.

---

## La pregunta que queda, y no es para la app

Que el roster tenga 111 activas de 115 y **ninguna baja registrada** mientras la
nómina enseña 16 que dejaron de cobrar **no es un fallo de esta aplicación**: es
una pregunta para RR.HH. La app puede decir quién dejó de cobrar; no puede saber
quién se fue, ni por qué, ni si alguien está de excedencia.

Las cifras de este documento **no se escriben en la pantalla**: se devuelven
calculadas desde `org.roster_current` en cada carga, para que la frase siga
siendo cierta el día que RR.HH. registre la primera baja.
