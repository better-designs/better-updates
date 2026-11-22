import { base64url, multipart, protocolHeaders, type Directive, type Manifest, type ManifestAsset } from "./protocol";
import { signBody } from "./signing";

/** Bindings and secrets the Worker reads. */
export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  /** Bearer token the publish command sends. */
  PUBLISH_TOKEN: string;
  /** PEM private key for update code signing. Optional until an app asks for signatures. */
  SIGNING_PRIVATE_KEY?: string;
}

type Platform = "ios" | "android";

interface UpdateRow {
  id: string;
  kind: "update" | "rollback";
  manifest: string | null;
  created_at: string;
}

/** What the publish command sends for one platform. */
interface PublishBody {
  channel: string;
  runtimeVersion: string;
  platform: Platform;
  launchAsset: Omit<ManifestAsset, "url">;
  assets: Omit<ManifestAsset, "url">[];
  metadata?: Record<string, string>;
  extra?: Manifest["extra"];
}

const PROJECT = "[a-z0-9][a-z0-9-]{0,62}";
const routes: [string, RegExp, (req: Request, env: Env, params: string[]) => Promise<Response>][] = [
  ["GET", new RegExp(`^/v1/projects/(${PROJECT})/manifest$`), serveManifest],
  ["GET", /^\/v1\/assets\/([A-Za-z0-9_-]{43})$/, serveAsset],
  ["PUT", new RegExp(`^/v1/projects/(${PROJECT})/assets/([A-Za-z0-9_-]{43})$`), uploadAsset],
  ["POST", new RegExp(`^/v1/projects/(${PROJECT})/updates$`), publishUpdate],
  ["POST", new RegExp(`^/v1/projects/(${PROJECT})/rollbacks$`), publishRollback],
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    for (const [method, pattern, handler] of routes) {
      const match = pathname.match(pattern);
      if (match && req.method === method) return handler(req, env, match.slice(1));
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function serveManifest(req: Request, env: Env, [project]: string[]): Promise<Response> {
  const url = new URL(req.url);
  const header = (name: string) => req.headers.get(name) ?? url.searchParams.get(name) ?? undefined;
  const platform = header("expo-platform");
  const runtimeVersion = header("expo-runtime-version");
  const channel = header("expo-channel-name") ?? "production";
  if (platform !== "ios" && platform !== "android") return json({ error: "expo-platform must be ios or android" }, 400);
  if (!runtimeVersion) return json({ error: "expo-runtime-version is required" }, 400);
  if (header("expo-protocol-version") !== "1") return json({ error: "only protocol version 1 is supported" }, 406);

  const expectSignature = req.headers.get("expo-expect-signature");
  if (expectSignature && !env.SIGNING_PRIVATE_KEY) return json({ error: "this server has no signing key" }, 400);
  const keyId = expectSignature?.match(/keyid="([^"]+)"/)?.[1] ?? "main";
  const sign = (body: string) => (expectSignature ? signBody(body, env.SIGNING_PRIVATE_KEY!, keyId) : undefined);

  const row = await env.DB.prepare(
    `SELECT id, kind, manifest, created_at FROM updates
     WHERE project = ? AND channel = ? AND runtime_version = ? AND platform = ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(project, channel, runtimeVersion, platform)
    .first<UpdateRow>();

  const currentId = req.headers.get("expo-current-update-id");
  const embeddedId = req.headers.get("expo-embedded-update-id");
  const directive = (d: Directive) => respond([{ name: "directive", body: JSON.stringify(d) }], sign);

  if (!row) return directive({ type: "noUpdateAvailable" });
  if (row.kind === "rollback") {
    if (currentId && currentId === embeddedId) return directive({ type: "noUpdateAvailable" });
    return directive({ type: "rollBackToEmbedded", parameters: { commitTime: row.created_at } });
  }
  if (currentId === row.id) return directive({ type: "noUpdateAvailable" });

  const manifest = JSON.parse(row.manifest!) as Manifest;
  const origin = url.origin;
  for (const asset of [manifest.launchAsset, ...manifest.assets]) asset.url = `${origin}/v1/assets/${asset.hash}`;
  return respond(
    [
      { name: "manifest", body: JSON.stringify(manifest) },
      { name: "extensions", body: JSON.stringify({ assetRequestHeaders: {} }) },
    ],
    sign,
  );
}

async function respond(
  parts: { name: "manifest" | "directive" | "extensions"; body: string }[],
  sign: (body: string) => Promise<string> | undefined,
): Promise<Response> {
  const signed = await Promise.all(
    parts.map(async (part) => (part.name === "extensions" ? part : { ...part, signature: await sign(part.body) })),
  );
  const { body, contentType } = multipart(signed);
  return new Response(body, { headers: { ...protocolHeaders, "content-type": contentType } });
}

async function serveAsset(_req: Request, env: Env, [hash]: string[]): Promise<Response> {
  const object = await env.ASSETS.get(`assets/${hash}`);
  if (!object) return json({ error: "asset not found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      // An asset never changes at its address: the address is its hash.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function uploadAsset(req: Request, env: Env, [, hash]: string[]): Promise<Response> {
  const denied = authorize(req, env);
  if (denied) return denied;
  if (await env.ASSETS.head(`assets/${hash}`)) return json({ hash, stored: false });
  const bytes = await req.arrayBuffer();
  if (base64url(await crypto.subtle.digest("SHA-256", bytes)) !== hash) {
    return json({ error: "the body does not match its hash" }, 400);
  }
  await env.ASSETS.put(`assets/${hash}`, bytes, {
    httpMetadata: { contentType: req.headers.get("content-type") ?? "application/octet-stream" },
  });
  return json({ hash, stored: true }, 201);
}

async function publishUpdate(req: Request, env: Env, [project]: string[]): Promise<Response> {
  const denied = authorize(req, env);
  if (denied) return denied;
  const body = (await req.json()) as PublishBody;
  const problem = checkTarget(body);
  if (problem) return json({ error: problem }, 400);

  const files = [body.launchAsset, ...body.assets];
  const missing = (await Promise.all(files.map(async (f) => ((await env.ASSETS.head(`assets/${f.hash}`)) ? null : f.hash)))).filter(Boolean);
  if (missing.length) return json({ error: "upload these assets first", missing }, 409);

  const manifest: Manifest = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion: body.runtimeVersion,
    launchAsset: { ...body.launchAsset, url: "" },
    assets: body.assets.map((asset) => ({ ...asset, url: "" })),
    metadata: body.metadata ?? {},
    extra: body.extra ?? {},
  };
  await insert(env, project, body, "update", manifest.id, manifest.createdAt, JSON.stringify(manifest));
  return json({ id: manifest.id, createdAt: manifest.createdAt }, 201);
}

async function publishRollback(req: Request, env: Env, [project]: string[]): Promise<Response> {
  const denied = authorize(req, env);
  if (denied) return denied;
  const body = (await req.json()) as Pick<PublishBody, "channel" | "runtimeVersion" | "platform">;
  const problem = checkTarget(body);
  if (problem) return json({ error: problem }, 400);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await insert(env, project, body, "rollback", id, createdAt, null);
  return json({ id, createdAt }, 201);
}

function insert(
  env: Env,
  project: string,
  target: Pick<PublishBody, "channel" | "runtimeVersion" | "platform">,
  kind: UpdateRow["kind"],
  id: string,
  createdAt: string,
  manifest: string | null,
) {
  return env.DB.prepare(
    `INSERT INTO updates (id, project, channel, runtime_version, platform, kind, manifest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, project, target.channel, target.runtimeVersion, target.platform, kind, manifest, createdAt)
    .run();
}

function checkTarget(body: Partial<Pick<PublishBody, "channel" | "runtimeVersion" | "platform">>): string | undefined {
  if (body.platform !== "ios" && body.platform !== "android") return "platform must be ios or android";
  if (!body.runtimeVersion) return "runtimeVersion is required";
  if (!body.channel) return "channel is required";
}

function authorize(req: Request, env: Env): Response | undefined {
  const expected = `Bearer ${env.PUBLISH_TOKEN}`;
  const given = req.headers.get("authorization") ?? "";
  if (!env.PUBLISH_TOKEN || !timingSafeEqual(given, expected)) return json({ error: "unauthorized" }, 401);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
