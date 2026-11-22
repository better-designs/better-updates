#!/usr/bin/env bun
/**
 * Publishes the output of `npx expo export` as one update per platform.
 *
 *   BETTER_UPDATES_TOKEN=... bun cli/publish.ts --server https://updates.example.com \
 *     --project my-app --channel production [--runtime-version 1.0.0] [--dist dist]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** The part of `dist/metadata.json` that `expo export` writes and we read. */
interface ExportMetadata {
  fileMetadata: Partial<Record<"ios" | "android", { bundle: string; assets: { path: string; ext: string }[] }>>;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  json: "application/json", mp3: "audio/mpeg", mp4: "video/mp4", wav: "audio/wav",
};

const { values: args } = parseArgs({
  options: {
    server: { type: "string" },
    project: { type: "string" },
    channel: { type: "string", default: "production" },
    "runtime-version": { type: "string" },
    dist: { type: "string", default: "dist" },
    message: { type: "string" },
  },
});

const token = process.env.BETTER_UPDATES_TOKEN;
if (!args.server || !args.project || !token) {
  fail("Set --server, --project and the BETTER_UPDATES_TOKEN environment variable.");
}
const server = args.server!.replace(/\/$/, "");
const dist = args.dist!;
const metadataPath = join(dist, "metadata.json");
if (!existsSync(metadataPath)) fail(`No ${metadataPath}. Run \`npx expo export\` first.`);

const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as ExportMetadata;
const expoClient = readExpoConfig();
const runtimeVersion = args["runtime-version"] ?? (typeof expoClient.runtimeVersion === "string" ? expoClient.runtimeVersion : undefined);
if (!runtimeVersion) {
  fail("The app config sets runtimeVersion as a policy. Pass the resolved value with --runtime-version.");
}

// Upload every file for every platform first, so a failed upload never leaves
// one platform published without the other.
const releases = [];
for (const [platform, files] of Object.entries(metadata.fileMetadata)) {
  if (!files) continue;
  const launchAsset = await upload(files.bundle, "application/javascript");
  const assets = [];
  for (const asset of files.assets) {
    const described = await upload(asset.path, CONTENT_TYPES[asset.ext] ?? "application/octet-stream");
    assets.push({ ...described, fileExtension: `.${asset.ext.toLowerCase()}` });
  }
  releases.push({ platform, launchAsset, assets });
}

for (const { platform, launchAsset, assets } of releases) {
  const result = await call(`/v1/projects/${args.project}/updates`, "POST", JSON.stringify({
    platform,
    channel: args.channel,
    runtimeVersion,
    launchAsset,
    assets,
    metadata: args.message ? { message: args.message } : {},
    extra: { expoClient },
  }));
  console.log(`${platform}: published update ${result.id} to ${args.channel} (runtime ${runtimeVersion})`);
}

async function upload(relativePath: string, contentType: string) {
  const bytes = readFileSync(join(dist, relativePath));
  const hash = createHash("sha256").update(bytes).digest("base64url");
  // Metro names bundled assets by their MD5, so the key must be the MD5 for the bundle to find them.
  const key = createHash("md5").update(bytes).digest("hex");
  await call(`/v1/projects/${args.project}/assets/${hash}`, "PUT", bytes, contentType);
  return { hash, key, contentType };
}

async function call(path: string, method: string, body: BodyInit, contentType = "application/json") {
  const res = await fetch(`${server}${path}`, {
    method,
    body,
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
  });
  const payload = (await res.json()) as { id?: string; error?: string };
  if (!res.ok) fail(`${method} ${path} failed with ${res.status}: ${payload.error ?? "no message"}`);
  return payload;
}

function readExpoConfig(): Record<string, unknown> {
  const saved = join(dist, "expoConfig.json");
  if (existsSync(saved)) return JSON.parse(readFileSync(saved, "utf8"));
  const output = execFileSync("npx", ["expo", "config", "--json", "--type", "public"], { encoding: "utf8" });
  return JSON.parse(output);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
