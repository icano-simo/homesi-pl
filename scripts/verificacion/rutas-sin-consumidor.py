# -*- coding: utf-8 -*-
"""
Que rutas de app/api/ no tiene llamando NADIE desde app/, components/ o lib/.

    python scripts/verificacion/rutas-sin-consumidor.py

Se escribio despues de encontrar tres muertos por casualidad --el modulo
pivot-table.tsx, /api/loan-validation/on-demand y /api/transactions/values, esta
ultima con su propia jubilacion anunciada en un comentario de types/index.ts
mientras el archivo seguia en su sitio--. Poder repetir el barrido vale mas que
el barrido de cualquier dia concreto.


╔══════════════════════════════════════════════════════════════════════════════╗
║  LEER ESTO ANTES DE BORRAR NADA POR LO QUE DIGA ESTE SCRIPT                   ║
╚══════════════════════════════════════════════════════════════════════════════╝

Su salida es un PRIMER CORTE, no una prueba. Tiene dos limitaciones conocidas, y
sin ellas delante alguien va a leer la lista como si fuera una sentencia.


  AVISO 1 — EL SESGO VA HACIA EL FALSO VIVO, A PROPOSITO.

  Una ruta /api/foo/[id]/bar nunca se escribe entera en el codigo que la llama:
  se construye, `/api/foo/${x}/bar`. Asi que no se busca la ruta completa sino
  su PREFIJO ESTATICO, el trozo anterior al primer segmento dinamico --de
  /api/cost-centers/[id]/rules queda /api/cost-centers/-- que matchea de sobra y
  da por vivas rutas hermanas que quiza no lo esten.

  La consecuencia esta elegida: PUEDE HABER MAS MUERTOS DE LOS QUE LISTA, y es
  improbable que alguno de los que lista este vivo. Un falso muerto cuesta una
  revision; un falso vivo se borra y rompe una pantalla en produccion.

  Corolario: que una ruta NO salga aqui no dice nada. No es una lista de rutas
  sanas, es una lista de sospechosas.


  AVISO 2 — NO DETECTA CADENAS DE MUERTOS.

  Solo pregunta "¿hay algun archivo que la nombre?". No pregunta si ESE archivo
  esta a su vez vivo. Una ruta que unicamente llama una pantalla huerfana sale
  VIVA aqui, y su pantalla tambien, sosteniendose la una a la otra.

  Para eso hace falta alcanzabilidad desde las rutas de navegacion reales, que
  este script no hace. Si el objetivo es limpiar de verdad, este es el paso 1.


  Y UNA TERCERA, menor: solo mira .ts y .tsx bajo app/, components/ y lib/. Una
  llamada desde un .mjs de scripts/, desde un cron o desde otra aplicacion
  --homesi-reporte-actividad comparte base de datos, no codigo-- no se ve desde
  aqui. Para una ruta que parezca un webhook o un endpoint de integracion,
  comprobar a mano antes de tocarla.


COMO VERIFICAR UNA CANDIDATA, que es lo que hay que hacer con cada una:

    git log --all --oneline -S "api/<la-ruta>" -- app components lib

  Salen dos commits: el que metio la llamada y el que la quito. El segundo dice
  POR QUE murio --casi siempre porque la sustituyo otra ruta-- y eso es lo que
  decide si se borra o si lo que falta es reconectarla.
"""
import io
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.path.join(ROOT, "app", "api")
SCAN = [os.path.join(ROOT, d) for d in ("app", "components", "lib")]


def leer(p):
    return io.open(p, encoding="utf-8", errors="replace").read()


def prefijo_estatico(ruta):
    """De /api/foo/[id]/bar deja /api/foo/ ; una ruta sin partes dinamicas queda entera."""
    partes = ruta.split("/")
    fijas = []
    for p in partes:
        if p.startswith("["):
            break
        fijas.append(p)
    est = "/".join(fijas)
    return est + "/" if len(fijas) < len(partes) else est


def main():
    if not os.path.isdir(API):
        sys.exit("no encuentro %s -- correr desde la raiz del repo" % API)

    # ── 1. Todas las rutas: cada carpeta con un route.ts es una ──────────────
    rutas = []
    for dirpath, _dirs, files in os.walk(API):
        if not any(f in files for f in ("route.ts", "route.tsx")):
            continue
        rel = os.path.relpath(dirpath, API).replace("\\", "/")
        rutas.append("/api" if rel == "." else "/api/" + rel)
    rutas.sort()

    # ── 2. Todo el codigo que podria llamarlas, excluidas las rutas ──────────
    fuentes = {}
    for base in SCAN:
        for dirpath, _dirs, files in os.walk(base):
            if os.path.normpath(dirpath).startswith(os.path.normpath(API)):
                continue
            for fn in files:
                if fn.endswith((".ts", ".tsx")):
                    p = os.path.join(dirpath, fn)
                    fuentes[p] = leer(p)

    # ── 3. Emparejar ────────────────────────────────────────────────────────
    muertas = []
    for r in rutas:
        pref = prefijo_estatico(r)
        # Loan Validation importa sus tipos del propio modulo de la ruta; eso
        # tambien cuenta como consumidor.
        mod = "@/app" + r + "/route"
        if not any(pref in s or mod in s for s in fuentes.values()):
            muertas.append(r)

    print("Rutas en app/api/: %d" % len(rutas))
    print("Archivos que podrian llamarlas: %d" % len(fuentes))
    print("")
    print("=" * 78)
    print("SIN NINGUN CONSUMIDOR: %d" % len(muertas))
    print("=" * 78)
    for r in muertas:
        print("  " + r)
    if not muertas:
        print("  (ninguna)")
    print("")
    print("NO es una sentencia. Leer los dos avisos de la cabecera de este")
    print("archivo, y verificar cada una con:")
    print('    git log --all --oneline -S "api/<la-ruta>" -- app components lib')

    return 0


if __name__ == "__main__":
    sys.exit(main())
