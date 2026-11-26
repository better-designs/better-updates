/**
 * End to end on real workerd: publish a fixture export with the CLI, then ask
 * for it the way `expo-updates` does, and verify the signature with Expo's own
 * code-signing library.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertCertificateToCertificatePEM,
  convertKeyPairToPEM,
  generateKeyPair,
  generateSelfSignedCodeSigningCertificate,
} from "@expo/code-signing-certificates";
import forge from "node-forge";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token";
const root = join(import.meta.dir, "..");
const state = mkdtempSync(join(tmpdir(), "better-updates-"));
const keyPair = generateKeyPair();
const certificate = generateSelfSignedCodeSigningCertificate({
  keyPair,
  validityNotBefore: new Date(Date.now() - 60_000),
  validityNotAfter: new Date(Date.now() + 86_400_000),
  commonName: "test",
});
let worker: ChildProcess;

beforeAll(async () => {
  const privateKey = convertKeyPairToPEM(keyPair).privateKeyPEM;
  writeFileSync(join(state, ".dev.vars"), `PUBLISH_TOKEN=${TOKEN}\nSIGNING_PRIVATE_KEY=${JSON.stringify(privateKey)}\n`);
  const migrate = spawnSync("bunx", ["wrangler", "d1", "migrations", "apply", "better-updates", "--local", "--persist-to", state], { cwd: root, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(migrate.stderr);
  worker = spawn("bunx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", state, "--env-file", join(state, ".dev.vars")], { cwd: root });
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${BASE}/v1/nothing`).then(() => true, () => false)) return;
    await Bun.sleep(500);
  }
  throw new Error("wrangler dev did not start");
}, 90_000);

afterAll(() => {
  worker?.kill();
  rmSync(state, { recursive: true, force: true });
});

function writeFixture(bundleText: string) {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(dist, "bundles"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "bundles/ios.hbc"), bundleText);
  writeFileSync(join(dist, "assets/abc"), "fake png bytes");
  writeFileSync(join(dist, "metadata.json"), JSON.stringify({
    version: 0,
    bundler: "metro",
    fileMetadata: { ios: { bundle: "bundles/ios.hbc", assets: [{ path: "assets/abc", ext: "png" }] } },
  }));
  writeFileSync(join(dist, "expoConfig.json"), JSON.stringify({ name: "Fixture", slug: "fixture", runtimeVersion: "1.0.0" }));
  return dist;
}

function publish(dist: string) {
  const run = spawnSync("bun", ["cli/publish.ts", "--server", BASE, "--project", "demo", "--dist", dist], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BETTER_UPDATES_TOKEN: TOKEN },
  });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return run.stdout;
}

/** Splits a multipart/mixed body into its named parts. */
function parseParts(body: string, contentType: string) {
  const boundary = contentType.split("boundary=")[1];
  const parts: Record<string, { body: string; signature?: string }> = {};
  for (const chunk of body.split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
    const name = head.match(/name="([^"]+)"/)![1];
    parts[name] = { body: rest.join("\r\n\r\n").replace(/\r\n$/, ""), signature: head.match(/expo-signature: (.+)/)?.[1] };
  }
  return parts;
}

function verify(body: string, signatureHeader: string) {
  const sig = signatureHeader.match(/sig="([^"]+)"/)![1];
  const md = forge.md.sha256.create();
  md.update(body, "utf8");
  const publicKey = forge.pki.certificateFromPem(convertCertificateToCertificatePEM(certificate)).publicKey as forge.pki.rsa.PublicKey;
  return publicKey.verify(md.digest().bytes(), forge.util.decode64(sig));
}

async function ask(headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/v1/projects/demo/manifest`, {
    headers: {
      "expo-protocol-version": "1",
      "expo-platform": "ios",
      "expo-runtime-version": "1.0.0",
      "expo-channel-name": "production",
      accept: "multipart/mixed",
      "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
      ...headers,
    },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("expo-protocol-version")).toBe("1");
  return parseParts(await res.text(), res.headers.get("content-type")!);
}

test("an app with no update yet hears that none is available", async () => {
  const parts = await ask();
  expect(JSON.parse(parts.directive.body)).toEqual({ type: "noUpdateAvailable" });
  expect(verify(parts.directive.body, parts.directive.signature!)).toBe(true);
});

test("a published update reaches the app, signed, with downloadable assets", async () => {
  const bundle = "console.log('v1')";
  expect(publish(writeFixture(bundle))).toContain("ios: published update");

  const parts = await ask();
  const manifest = JSON.parse(parts.manifest.body);
  expect(verify(parts.manifest.body, parts.manifest.signature!)).toBe(true);
  expect(manifest.runtimeVersion).toBe("1.0.0");
  expect(manifest.extra.expoClient.slug).toBe("fixture");
  expect(manifest.launchAsset.key).toBe(createHash("md5").update(bundle).digest("hex"));

  const download = await fetch(manifest.launchAsset.url);
  const bytes = Buffer.from(await download.arrayBuffer());
  expect(createHash("sha256").update(bytes).digest("base64url")).toBe(manifest.launchAsset.hash);
  expect(manifest.assets[0].fileExtension).toBe(".png");

  const again = await ask({ "expo-current-update-id": manifest.id });
  expect(JSON.parse(again.directive.body)).toEqual({ type: "noUpdateAvailable" });
});

test("a rollback sends the app back to the update inside its binary", async () => {
  const res = await fetch(`${BASE}/v1/projects/demo/rollbacks`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: "production", runtimeVersion: "1.0.0", platform: "ios" }),
  });
  expect(res.status).toBe(201);
  const parts = await ask({ "expo-current-update-id": "some-update", "expo-embedded-update-id": "embedded" });
  const directive = JSON.parse(parts.directive.body);
  expect(directive.type).toBe("rollBackToEmbedded");
  expect(verify(parts.directive.body, parts.directive.signature!)).toBe(true);
});

test("publishing needs the token, and an asset must match its hash", async () => {
  const noToken = await fetch(`${BASE}/v1/projects/demo/rollbacks`, { method: "POST", body: "{}" });
  expect(noToken.status).toBe(401);
  const wrongHash = await fetch(`${BASE}/v1/projects/demo/assets/${"A".repeat(43)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "not that",
  });
  expect(wrongHash.status).toBe(400);
});

test("an update with a bad file description or a page-like file is refused", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const html = await fetch(`${BASE}/v1/projects/demo/assets/${"B".repeat(43)}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "text/html" },
    body: "<script>alert(1)</script>",
  });
  expect(html.status).toBe(415);
  const badJson = await fetch(`${BASE}/v1/projects/demo/updates`, { method: "POST", headers: auth, body: "{" });
  expect(badJson.status).toBe(400);
  const noAssets = await fetch(`${BASE}/v1/projects/demo/updates`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ channel: "production", runtimeVersion: "1.0.0", platform: "ios" }),
  });
  expect(noAssets.status).toBe(400);
});

test("a project key publishes to its own project and nowhere else", async () => {
  const admin = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const created = await fetch(`${BASE}/v1/projects`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ slug: "team-a", owner: "user_123" }),
  });
  expect(created.status).toBe(201);
  const { key } = (await created.json()) as { key: string };
  expect(key).toMatch(/^bu_[a-f0-9]{48}$/);

  const again = await fetch(`${BASE}/v1/projects`, { method: "POST", headers: admin, body: JSON.stringify({ slug: "team-a" }) });
  expect(again.status).toBe(409);

  const rollback = (project: string, token: string) =>
    fetch(`${BASE}/v1/projects/${project}/rollbacks`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "production", runtimeVersion: "1.0.0", platform: "android" }),
    });
  expect((await rollback("team-a", key)).status).toBe(201);
  expect((await rollback("demo", key)).status).toBe(401);

  const noAdmin = await fetch(`${BASE}/v1/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ slug: "team-b" }),
  });
  expect(noAdmin.status).toBe(401);

  const rotated = await fetch(`${BASE}/v1/projects/team-a/keys`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
  expect(rotated.status).toBe(201);
  const { key: newKey } = (await rotated.json()) as { key: string };
  expect((await rollback("team-a", key)).status).toBe(401);
  expect((await rollback("team-a", newKey)).status).toBe(201);
});
