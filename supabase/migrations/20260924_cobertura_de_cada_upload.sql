-- ─────────────────────────────────────────────────────────────────────────────
-- QUE TRAJO CADA ARCHIVO, AUNQUE SUS FILAS YA NO ESTEN
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `pl_uploads` guarda `row_count` y nada mas sobre el contenido. Los periodos
-- y las sucursales de un upload solo existen en sus FILAS, asi que borrarlo
-- borra tambien la evidencia de lo que trajo.
--
-- ⚠ LO QUE COSTO NO TENERLO, el 2026-09-24. A la pregunta "¿cuantas veces ha
-- pasado que un archivo traiga un mes que ya estaba cargado por otro?" no se
-- pudo contestar. El estado actual solo enseña lo que queda DESPUES de
-- limpiar: junio se cargo dos veces en dos dias y no queda rastro de ninguna
-- de las dos, y el upload `isabella.cano 15092026041933548.xlsx` --que esa
-- mañana tenia las sucursales 728 y 733-- ya no existe en la tabla.
--
-- El unico rastro que sobrevive es indirecto y hay que saber leerlo: el
-- archivo grande declara `row_count` 11.092 y tiene 9.792 filas vivas. Las
-- 1.300 que faltan son junio. Eso no es un registro, es una resta.
--
-- ⚠ SE RELLENA HACIA ATRAS SOLO CON LO QUE HAY. Los uploads cuyas filas se
-- borraron quedan con la cobertura que les queda --o vacia-- y NO se
-- reconstruye de ningun sitio: no hay de donde. Un `[]` aqui significa "ya no
-- se sabe", no "no trajo nada", y por eso la columna admite NULL: NULL es
-- "nunca se calculo" y `[]` es "se calculo y no quedaba nada".

ALTER TABLE finance_division.pl_uploads
  ADD COLUMN IF NOT EXISTS coverage JSONB;

COMMENT ON COLUMN finance_division.pl_uploads.coverage IS
  'Que periodos y sucursales trajo este archivo: [{"year":2026,"month":"June",'
  '"branch":"700","rows":1300}]. Se escribe al completar la subida y NO se '
  'actualiza si luego se borran filas -- es el registro de lo que trajo, no de '
  'lo que queda. NULL = nunca se calculo (uploads anteriores al 2026-09-24 sin '
  'filas vivas); [] = se calculo y no quedaba nada.';

-- Relleno hacia atras desde las filas que aun existen.
UPDATE finance_division.pl_uploads u
   SET coverage = c.resumen
  FROM (
    SELECT upload_id,
           jsonb_agg(jsonb_build_object(
             'year', year, 'month', month, 'branch', branch, 'rows', n
           ) ORDER BY year, month, branch) resumen
      FROM (
        SELECT upload_id, year, month, branch, count(*) n
          FROM finance_division.pl_transactions
         WHERE upload_id IS NOT NULL
         GROUP BY upload_id, year, month, branch
      ) g
     GROUP BY upload_id
  ) c
 WHERE c.upload_id = u.id
   AND u.coverage IS NULL;

-- ── Comprobacion ────────────────────────────────────────────────────────────
--
-- select file_name, to_char(uploaded_at,'MM-DD HH24:MI') subido, row_count,
--        jsonb_array_length(coalesce(coverage,'[]'::jsonb)) tramos,
--        (select sum((x->>'rows')::int) from jsonb_array_elements(coalesce(coverage,'[]'::jsonb)) x) filas_en_cobertura
--   from finance_division.pl_uploads order by uploaded_at;
--
-- ⚠ `filas_en_cobertura` NO tiene por que igualar a `row_count`: el declarado
-- es lo que traia el archivo y la cobertura, lo que quedaba al calcularla. En
-- el archivo grande son 9.792 contra 11.092 declaradas, y esa diferencia ES el
-- dato -- 1.300 filas de junio que se borraron.
