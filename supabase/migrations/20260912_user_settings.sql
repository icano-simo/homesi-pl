-- ═══════════════════════════════════════════════════════════════════════════
-- user_settings — el filtro de sucursal deja de ser de todos
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL PROBLEMA
--
-- finance_division.app_settings tiene UNA fila, id='global'. Quien cambia el
-- filtro se lo cambia a todos, en vivo, y nadie ve que la cifra que mira
-- responde al filtro que puso otro. Medido el 2026-09-12: 28 usuarios, 17 con
-- sesion en los ultimos 30 dias y 5 el mismo dia en que se toco esa fila.
--
-- Y con las notas ancladas a la sucursal el fallo no se queda en la pantalla:
-- alguien escribe una nota creyendo que es de la 716 mientras otro le cambio el
-- filtro a la 700, la nota queda mal anclada y despues no hay forma de saberlo.
-- 17 de las 21 notas existentes llevan branch en su scope.
--
-- POR QUE UNA TABLA NUEVA Y NO UNA FILA POR USUARIO EN app_settings
--
-- La clave de app_settings es `id text default 'global'`. Meter uuids ahi deja
-- una tabla con dos cosas distintas dentro -un valor por defecto y las
-- preferencias de cada uno- separadas solo por si el texto parece un uuid.
-- Toda consulta tendria que conocer esa convencion. Aqui "esto es por usuario"
-- lo dice el esquema y no una convencion de nombres.
--
-- Primera clave ajena a auth.users del proyecto: ninguna tabla de
-- finance_division referencia auth hoy. Es la practica normal en Supabase y es
-- lo que hace que borrar a alguien se lleve sus preferencias.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance_division.user_settings (
  user_id         uuid primary key references auth.users(id) on delete cascade,

  -- Mismo tipo y misma semantica que app_settings.active_branches: lista vacia
  -- significa "sin restriccion", no "ninguna sucursal". mergeWithGlobal ya lee
  -- el vacio asi y no hay que cambiarlo.
  active_branches text[] not null default '{}',

  updated_at      timestamptz not null default now()
);

comment on table finance_division.user_settings is
  'Preferencias por usuario. Hoy solo el filtro de sucursal, que antes era una fila global compartida por los 28 usuarios: quien la cambiaba se la cambiaba a todos en vivo, y con las notas ancladas a branch eso deja notas mal ancladas e indetectables.';

comment on column finance_division.user_settings.active_branches is
  'Lista vacia = sin restriccion, igual que en app_settings. No confundir con "ninguna sucursal".';

-- ── Semilla: cada usuario arranca donde estaba ─────────────────────────────
--
-- Se copia el valor global a los 28 usuarios en vez de dejar que la fila global
-- siga siendo un respaldo vivo. Con respaldo vivo, quien editara la fila global
-- seguiria cambiandosela a todo el que no tuviera fila propia: el fallo
-- sobreviviria justo para quien todavia no ha tocado el filtro.
--
-- Copiandolo una vez, cada uno queda independiente desde el primer momento y
-- nadie nota el cambio: todos siguen viendo lo que veian.

insert into finance_division.user_settings (user_id, active_branches)
select u.id, coalesce(s.active_branches, '{}')
from auth.users u
left join finance_division.app_settings s on s.id = 'global'
on conflict (user_id) do nothing;

-- ── La fila global se queda, con otro significado ──────────────────────────
--
-- No se descarta: pasa a ser el valor por defecto de quien todavia no tiene
-- fila propia, es decir de los usuarios que se den de alta a partir de ahora.
-- Deja de ser lo que todos miran y pasa a ser de donde arranca uno nuevo.
--
-- Escrito en la tabla porque el cambio es de SIGNIFICADO y no de estructura:
-- la columna es la misma, y sin esto el siguiente que la lea la interpretara
-- como la interpretaba la aplicacion hasta hoy.

comment on table finance_division.app_settings is
  'Valor por defecto para un usuario que aun no tiene fila en user_settings. YA NO es el filtro que comparte todo el mundo: eso cambio el 2026-09-12 porque quien lo tocaba se lo cambiaba a los demas en vivo. Cambiar esta fila no afecta a nadie que ya tenga preferencia propia.';

comment on column finance_division.app_settings.active_branches is
  'Solo el arranque de un usuario nuevo. El filtro que usa cada persona vive en finance_division.user_settings.';

-- ── Row level security ─────────────────────────────────────────────────────
-- RLS activo, CERO politicas, permisos solo a service_role: el mismo modelo de
-- las otras 19 tablas del esquema. service_role salta RLS, asi que una politica
-- para el no concederia nada y seria la unica del esquema.
--
-- Sin `grant usage on schema`: service_role ya tiene USAGE en finance_division,
-- comprobado con has_schema_privilege.
--
-- Que la aplicacion lea y escriba con service_role significa que el filtro por
-- usuario NO lo impone la base: lo impone el endpoint, que saca el user_id de
-- requireSession y nunca del cuerpo de la peticion. Es una decision, no un
-- descuido, y por eso queda escrita: si algun dia el navegador hablara directo
-- con Supabase, esto necesita politicas de verdad sobre auth.uid().

alter table finance_division.user_settings enable row level security;

grant select, insert, update, delete on finance_division.user_settings to service_role;
