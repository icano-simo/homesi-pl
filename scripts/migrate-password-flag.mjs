#!/usr/bin/env node
/**
 * Copies must_change_password from user_metadata into app_metadata.
 *
 *   node scripts/migrate-password-flag.mjs --dry-run
 *   node scripts/migrate-password-flag.mjs
 *
 * The other apps in this shared Supabase project keep the flag in
 * user_metadata, which the account holder can rewrite from the browser with
 * auth.updateUser(). Homesí reads app_metadata instead, where only the service
 * role can write — the flag is an authorisation decision, not a preference.
 *
 * COPIES rather than moves: user_metadata is left untouched so the HR and PMO
 * apps keep working against the convention they already use. The cost is that
 * the two can drift; Homesí trusts only its own copy.
 *
 * Idempotent — a user whose app_metadata already carries the flag is skipped.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");

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

console.log(`usuarios: ${users.length}${DRY ? "   (DRY RUN, no se escribe nada)" : ""}`);
console.log("");

let copied = 0, skipped = 0, absent = 0, failed = 0;

for (const u of users) {
  const fromUser = u.user_metadata?.must_change_password;
  const already = u.app_metadata?.must_change_password;

  if (already !== undefined) { skipped++; continue; }
  if (fromUser === undefined) { absent++; continue; }

  const masked = (u.email ?? "?").replace(/^(.{2}).*(@.*)$/, "$1***$2");

  if (DRY) {
    console.log(`  copiaria  ${masked}  must_change_password=${fromUser}`);
    copied++;
    continue;
  }

  const { error } = await admin.auth.admin.updateUserById(u.id, {
    app_metadata: { ...u.app_metadata, must_change_password: fromUser === true },
  });

  if (error) { console.log(`  FALLO     ${masked}: ${error.message}`); failed++; }
  else { console.log(`  copiado   ${masked}  must_change_password=${fromUser === true}`); copied++; }
}

console.log("");
console.log(`copiados            : ${copied}`);
console.log(`ya lo tenian        : ${skipped}`);
console.log(`sin flag en ninguno : ${absent}`);
console.log(`fallidos            : ${failed}`);
