-- ─────────────────────────────────────────────────────────────────────────────
-- EL HASH DEL ARCHIVO ENTERO, PARA SABER QUE YA SE SUBIO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `pl_uploads` guarda id, file_name, uploaded_at, row_count, status y
-- error_message. Nada que identifique el CONTENIDO.
--
-- ⚠ EL CASO, 2026-09-23. El mismo archivo --"kelly.ovalle
-- 23092026093601760.xlsx", 1.156 filas-- se subio a las 16:43 y otra vez a las
-- 17:02. Agosto paso de -45.547,22 a -91.094,45.
--
-- La deteccion de duplicados SI salto: devolvio 409 y abrio el dialogo. Lo que
-- no hizo fue decir lo unico que importaba -- que era EL MISMO ARCHIVO, con el
-- mismo nombre, subido 19 minutos antes. Comparaba solape de PERIODOS, y con
-- ese aviso "este periodo ya tiene datos" es cierto casi siempre y no distingue
-- un error de un reparto legitimo por sucursal.
--
-- ⚠ SOLO EL ARCHIVO ENTERO, Y ESTO ES UNA DECISION MEDIDA. La version fila a
-- fila se descarto: en `offshore_allocations` las filas NO llevan fecha ni
-- descripcion, asi que (persona, cuenta, importe) iguales es lo que produce una
-- NOMINA QUINCENAL. Ese criterio señalo 16 "duplicados" de enero que eran dos
-- quincenas legitimas de cada persona, se borraron y hubo que reponerlos. Un
-- hash de archivo no tiene ese problema: no depende de que las filas sean
-- distinguibles entre si.
--
-- ⚠ NO SE RELLENA EL HASH DE LOS UPLOADS EXISTENTES. Los archivos no se
-- guardan, solo sus filas, asi que no hay de donde calcularlo. Se quedan en
-- NULL y la comparacion por hash simplemente no los alcanza -- la del nombre
-- si. Inventar un hash a partir de las filas seria otro criterio que parece
-- concluyente y no lo es.

ALTER TABLE finance_division.pl_uploads
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

COMMENT ON COLUMN finance_division.pl_uploads.file_hash IS
  'SHA-256 del archivo subido, en hexadecimal, calculado en el servidor sobre '
  'los bytes recibidos. Sirve para avisar de que un archivo ya se cargo aunque '
  'le hayan cambiado el nombre. NULL en los uploads anteriores al 2026-09-23: '
  'los archivos no se guardan y no hay de donde calcularlo. NO es un hash por '
  'fila -- ver la nota de lib/check-duplicate-upload.ts sobre por que eso no '
  'distingue un duplicado de dos quincenas en offshore_allocations.';

-- Se consulta en cada subida, por igualdad exacta.
CREATE INDEX IF NOT EXISTS pl_uploads_file_hash_idx
  ON finance_division.pl_uploads (file_hash)
  WHERE file_hash IS NOT NULL;

-- Y por nombre, que es la otra mitad del aviso y hoy no tiene indice.
CREATE INDEX IF NOT EXISTS pl_uploads_file_name_idx
  ON finance_division.pl_uploads (file_name);

-- ── Comprobacion ────────────────────────────────────────────────────────────
--
-- select column_name from information_schema.columns
--  where table_schema='finance_division' and table_name='pl_uploads'
--    and column_name='file_hash';
--
-- select count(*) filter (where file_hash is null) sin_hash, count(*) total
--   from finance_division.pl_uploads;
--   -> al aplicarla, sin_hash = total. Se va llenando a partir de la proxima
--      subida; los viejos se quedan sin el, y eso es lo cierto sobre ellos.
