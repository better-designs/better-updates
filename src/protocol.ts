/**
 * Expo Updates protocol, version 1: the response shapes a conformant
 * `expo-updates` client accepts. Spec: https://docs.expo.dev/technical-specs/expo-updates-1/
 */

/** One file an update needs, as the manifest lists it. */
export interface ManifestAsset {
  /** Base64URL SHA-256 of the file; the client checks it after download. */
  hash: string;
  /** Name the bundle uses for the file. Metro uses the file's MD5 in hex. */
  key: string;
  contentType: string;
  fileExtension?: string;
  url: string;
}

/** The manifest of one published update. */
export interface Manifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: ManifestAsset;
  assets: ManifestAsset[];
  metadata: Record<string, string>;
  extra: { expoClient?: unknown } & Record<string, unknown>;
}

/** An instruction sent in place of an update. */
export type Directive =
  | { type: "noUpdateAvailable" }
  | { type: "rollBackToEmbedded"; parameters: { commitTime: string } };

/** A multipart part the response carries. */
interface Part {
  name: "manifest" | "directive" | "extensions";
  body: string;
  signature?: string;
}

/** Builds the `multipart/mixed` response body and its content type. */
export function multipart(parts: Part[]): { body: string; contentType: string } {
  const boundary = `bu-${crypto.randomUUID()}`;
  const chunks = parts.map((part) => {
    const headers = [
      `Content-Disposition: form-data; name="${part.name}"`,
      "Content-Type: application/json; charset=utf-8",
    ];
    if (part.signature) headers.push(`expo-signature: ${part.signature}`);
    return `--${boundary}\r\n${headers.join("\r\n")}\r\n\r\n${part.body}\r\n`;
  });
  return {
    body: `${chunks.join("")}--${boundary}--\r\n`,
    contentType: `multipart/mixed; boundary=${boundary}`,
  };
}

/** Headers every protocol response carries. */
export const protocolHeaders = {
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
  "cache-control": "private, max-age=0",
} as const;

/** Base64URL without padding, as the spec asks for asset hashes. */
export function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
