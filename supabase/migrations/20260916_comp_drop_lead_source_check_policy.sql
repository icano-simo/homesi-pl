-- ═══════════════════════════════════════════════════════════════════════════
-- comp.lead_source_check deja de ser legible desde el navegador
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ NO EJECUTADA. Se escribe para que la aplique el usuario.
--
-- QUE PASA HOY
--
-- `comp.lead_source_check` es la UNICA tabla del esquema `comp` con politica
-- RLS, y una de las dos unicas de toda la base con una:
--
--     lead_source_check_select · {authenticated} · SELECT
--     qual: auth.jwt() -> app_metadata -> allowed_apps ? 'homesi'
--
-- Y ademas tiene el GRANT que la acompaña: `authenticated` con SELECT. Las
-- dos cosas juntas significan que cualquier usuario logueado de homesi puede
-- leerla directamente contra PostgREST, sin pasar por la app.
--
-- Hoy no expone nada porque la tabla tiene cero filas. Cargada expondria la
-- comision, el bonus, el override y la recuperacion de cada persona con
-- nombre y apellidos, a cualquiera que sepa escribir una URL.
--
-- ⚠ NO FUE UN DESCUIDO DE SINTAXIS, Y AUN ASI SE QUITA
--
-- Se miro antes de tocarla, y lo que se encuentra apunta a algo escrito a
-- proposito y no a un resbalon:
--
--   · Son DOS pasos, no uno: la politica y el grant. Un `enable row level
--     security` de mas no produce ninguno de los dos.
--   · El predicado esta pensado -- `allowed_apps ? 'homesi'` es la forma
--     multi-app correcta, no un `using (true)`.
--
-- Pero la razon por la que se escribio NO EXISTE en el codigo:
--
--   · NINGUNA PANTALLA LA LEE. `lead_source_check` no aparece ni una vez en
--     `app/`, `components/` ni `lib/`. Y la app no lee `comp` desde el
--     navegador: va por `createServerClient("comp")` con la service role
--     (lib/supabase-server.ts), que salta RLS y no necesita politica ninguna.
--   · CONTRADICE EL PATRON DEL PROPIO ESQUEMA. La migracion fundacional
--     `20260912232733 comp_compensafe_mirror` deja las dos tablas con
--     `enable row level security` y CERO politicas, y los grants solo a
--     service_role. Eso fue una decision, no un olvido: esta escrito en el
--     mismo bloque.
--   · LA TABLA NO ESTA EN EL HISTORIAL DE MIGRACIONES. Ninguna de las 118
--     migraciones registradas menciona `lead_source_check`: se creo por
--     fuera, y con ella la politica.
--
-- Asi que la lectura es: se escribio pensando en una pantalla que no llego a
-- construirse, sobre una tabla que se puso en espera. Queda un permiso vivo
-- sin nada que lo use, que es justo la clase de permiso que nadie revisa.
--
-- ⚠ SE QUITAN LAS DOS COSAS, NO SOLO LA POLITICA. Con RLS activo y sin
-- politica, `authenticated` ya no ve filas aunque conserve el GRANT. Pero
-- dejar el grant puesto significa que el dia que alguien añada una politica
-- --para otra cosa, con otro criterio-- la tabla se abre otra vez sin que esa
-- persona se entere de que estaba a un paso. El grant es la mitad silenciosa
-- del permiso.
--
-- SI ALGUN DIA HACE FALTA LEERLA DESDE EL NAVEGADOR, se vuelve a poner con su
-- pantalla delante y su motivo escrito. Reponer dos lineas es barato; lo caro
-- es un permiso abierto que nadie sabe por que esta.

drop policy if exists lead_source_check_select on comp.lead_source_check;

revoke select on comp.lead_source_check from authenticated;

comment on table comp.lead_source_check is
  'Compara lo que se PAGO contra la regla de comision VIGENTE en la fecha de cierre. Desde comp_marts.mart_lead_source_check. Responde la pregunta que ninguna otra tabla responde: se pago lo que correspondia. ⚠ ESTA VACIA A PROPOSITO: el sync se puso en espera por decision del usuario, la tabla se creo y el spec no se activo. Cero filas y synced_at nulo NO es una carga rota. ⚠ Y NO SE LEE DESDE EL NAVEGADOR: tenia la unica politica RLS del esquema mas un GRANT a authenticated, se retiraron el 2026-09-16 porque ninguna pantalla la lee y el esquema entero es RLS activo + cero politicas + service_role, como dejo escrito 20260912232733 comp_compensafe_mirror.';
