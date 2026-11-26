#!/usr/bin/env bun
/**
 * One command to run Better Updates on your own Cloudflare account:
 * creates the database and the bucket, applies the schema, stores a publish
 * token, and deploys. Safe to run again: it reuses what already exists.
 *
 *   bun run setup [--signing-key keys/private-key.pem]
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { "signing-key": { type: "string" } } });
const CONFIG = "wrangler.toml";
const DATABASE = "better-updates";
const BUCKET = "better-updates-assets";

function wrangler(params: string[], input?: string): string {
  return execFileSync("bunx", ["wrangler", ...params], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

function step(label: string) {
  console.log(`\n${label}`);
}

step("1. Database");
let config = readFileSync(CONFIG, "utf8");
if (config.includes('database_id = "local"')) {
  const list = JSON.parse(wrangler(["d1", "list", "--json"])) as { name: string; uuid: string }[];
  const id = list.find((db) => db.name === DATABASE)?.uuid ?? wrangler(["d1", "create", DATABASE]).match(/database_id = "([^"]+)"/)?.[1];
  if (!id) throw new Error("Could not read the new database id from wrangler.");
  config = config.replace('database_id = "local"', `database_id = "${id}"`);
  writeFileSync(CONFIG, config);
  console.log(`   using ${DATABASE} (${id})`);
} else {
  console.log("   already set in wrangler.toml");
}

step("2. Asset bucket");
try {
  wrangler(["r2", "bucket", "create", BUCKET]);
  console.log(`   created ${BUCKET}`);
} catch (error) {
  if (!String((error as { stderr?: string }).stderr).includes("already exists")) throw error;
  console.log(`   ${BUCKET} already exists`);
}

step("3. Schema");
wrangler(["d1", "migrations", "apply", DATABASE, "--remote"]);
console.log("   applied");

step("4. Deploy");
const deployed = wrangler(["deploy"]);
const url = deployed.match(/https:\/\/\S+\.workers\.dev/)?.[0] ?? "(see the wrangler output)";
console.log(`   live at ${url}`);

step("5. Secrets");
const secrets = (JSON.parse(wrangler(["secret", "list", "--format", "json"])) as { name: string }[]).map((s) => s.name);
let token: string | undefined;
if (!secrets.includes("PUBLISH_TOKEN")) {
  token = randomBytes(24).toString("hex");
  wrangler(["secret", "put", "PUBLISH_TOKEN"], token);
}
if (args["signing-key"]) {
  if (!existsSync(args["signing-key"])) throw new Error(`No file at ${args["signing-key"]}`);
  wrangler(["secret", "put", "SIGNING_PRIVATE_KEY"], readFileSync(args["signing-key"], "utf8"));
  console.log("   signing key stored");
}
console.log(token ? "   publish token created" : "   publish token already set");

console.log(`
Done. Next:
  1. In app.json set "updates": { "url": "${url}/v1/projects/<your-project>/manifest" } and build a new binary.
  2. Publish: BETTER_UPDATES_TOKEN=${token ?? "<your token>"} bun cli/publish.ts --server ${url} --project <your-project>`);
if (token) console.log("\nSave the token now. It is stored only as a Worker secret and is not shown again.");
