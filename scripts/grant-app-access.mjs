#!/usr/bin/env node
/**
 * Grants or revokes access to an app by editing app_metadata.allowed_apps.
 *
 *   node scripts/grant-app-access.mjs --list
 *   node scripts/grant-app-access.mjs someone@supremelending.com otra@supremelending.com
 *   node scripts/grant-app-access.mjs --revoke someone@supremelending.com
 *   node scripts/grant-app-access.mjs --app hr someone@supremelending.com
 *   node scripts/grant-app-access.mjs --dry-run someone@supremelending.com
 *
 * The Supabase project is shared with the other portal apps, so holding a valid
 * session only proves the person works here. allowed_apps is what says which
 * apps they may actually open, and it lives in app_metadata because only the
 * service role can write there — in user_metadata the account holder could
 * grant themselves access from the browser.
 *
 * Adds to the array rather than replacing it, so granting Homesí never removes
 * someone's access to HR or PMO.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const REVOKE = argv.includes("--revoke");
const LIST = argv.includes("--list");

const appIdx = argv.indexOf("--app");
const APP = appIdx >= 0 ? argv[appIdx + 1] : "homesi";

const emails = argv.filter((a, i) => !a.startsWith("--") && !(appIdx >= 0 && i === appIdx + 1));

if (!LIST && emails.length === 0) {
  console.error("Uso: node scripts/grant-app-access.mjs [--app <nombre>] [--revoke] [--dry-run] <correo> [correo...]");
  console.error("     node scripts/grant-app-access.mjs --list");
  process.exit(1);
}

const env = {};
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {
  console.error("No se pudo leer .env.local desde la raiz del proyecto.");
  process.exit(1);
}

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local");
  process.exit(1);
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const users = [];
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error("listUsers: " + error.message); process.exit(1); }
  if (!data.users.length) break;
  users.push(...data.users);
  if (data.users.length < 200) break;
}

const byEmail = new Map(users.map((u) => [(u.email ?? "").toLowerCase(), u]));

// ── --list: who currently has access, without granting anything ────────────
if (LIST) {
  console.log(`usuarios: ${users.length}    app consultada: ${APP}`);
  console.log("");
  console.log("acceso  correo                                    allowed_apps");
  for (const u of users.sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""))) {
    const apps = u.app_metadata?.allowed_apps;
    const has = Array.isArray(apps) && apps.includes(APP);
    console.log(
      `  ${has ? "SI " : "no "}   ${(u.email ?? "?").padEnd(40)}  ` +
      (Array.isArray(apps) ? JSON.stringify(apps) : "(sin campo)")
    );
  }
  process.exit(0);
}

console.log(`app: ${APP}    accion: ${REVOKE ? "REVOCAR" : "otorgar"}${DRY ? "    (DRY RUN)" : ""}`);
console.log("");

let done = 0, unchanged = 0, missing = 0, failed = 0;

for (const raw of emails) {
  const email = raw.toLowerCase();
  const u = byEmail.get(email);

  if (!u) { console.log(`  NO EXISTE  ${raw}`); missing++; continue; }

  const current = Array.isArray(u.app_metadata?.allowed_apps) ? u.app_metadata.allowed_apps : [];
  const has = current.includes(APP);

  if (REVOKE ? !has : has) {
    console.log(`  sin cambio ${raw}  -> ${JSON.stringify(current)}`);
    unchanged++;
    continue;
  }

  // Union / difference, never a wholesale replace: someone's HR and PMO access
  // must survive a change to their Homesí access.
  const next = REVOKE ? current.filter((a) => a !== APP) : [...current, APP];

  if (DRY) {
    console.log(`  ${REVOKE ? "revocaria" : "otorgaria"} ${raw}  ${JSON.stringify(current)} -> ${JSON.stringify(next)}`);
    done++;
    continue;
  }

  const { error } = await admin.auth.admin.updateUserById(u.id, {
    app_metadata: { ...u.app_metadata, allowed_apps: next },
  });

  if (error) { console.log(`  FALLO      ${raw}: ${error.message}`); failed++; }
  else { console.log(`  ${REVOKE ? "revocado " : "otorgado "} ${raw}  -> ${JSON.stringify(next)}`); done++; }
}

console.log("");
console.log(`aplicados  : ${done}`);
console.log(`sin cambio : ${unchanged}`);
console.log(`no existen : ${missing}`);
console.log(`fallidos   : ${failed}`);
console.log("");
console.log("Nota: app_metadata viaja dentro del token. Quien tenga sesion abierta");
console.log("no vera el cambio hasta que su token se refresque (hasta 1 hora) o");
console.log("vuelva a iniciar sesion.");
