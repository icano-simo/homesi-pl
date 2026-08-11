#!/usr/bin/env node
/**
 * Creates a user with a temporary password that must be replaced on first login.
 *
 *   node scripts/create-user.mjs someone@supremelending.com
 *   node scripts/create-user.mjs someone@supremelending.com "CustomTempPass123"
 *
 * must_change_password goes in app_metadata, not user_metadata: user_metadata is
 * writable by the account holder through auth.updateUser(), so a user could
 * clear the flag from the browser and skip the change. app_metadata is only
 * writable with the service role, which lives on the server.
 *
 * email_confirm is set so the account is usable immediately — otherwise the
 * user cannot sign in until they click a confirmation link, which defeats the
 * point of handing them a temporary password.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const DEFAULT_TEMP_PASSWORD = "Homesi-Temp-2026";

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch {
    console.error("Could not read .env.local from the project root.");
    process.exit(1);
  }
  return env;
}

const [email, passwordArg] = process.argv.slice(2);

if (!email) {
  console.error("Usage: node scripts/create-user.mjs <email> [temporaryPassword]");
  process.exit(1);
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env.local");
  process.exit(1);
}

const password = passwordArg || DEFAULT_TEMP_PASSWORD;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data, error } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  // allowed_apps grants this app specifically. The Supabase project is shared
  // with the other portal apps, so a session alone is not authorisation — see
  // scripts/grant-app-access.mjs for granting or revoking it later.
  app_metadata: { must_change_password: true, allowed_apps: ["homesi"] },
});

if (error) {
  console.error("Failed: " + error.message);
  process.exit(1);
}

console.log("User created");
console.log("  email    : " + data.user.email);
console.log("  id       : " + data.user.id);
console.log("  password : " + password + "   (temporary — must be changed at first login)");
console.log("");
console.log("They will be redirected to /change-password until they set their own.");
