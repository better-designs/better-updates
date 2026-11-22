/**
 * Update code signing: an RSA-SHA256 signature over each manifest or directive
 * body, sent as the `expo-signature` structured header.
 */

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Signs `body` and returns the `expo-signature` header value. */
export async function signBody(body: string, privateKeyPem: string, keyId: string): Promise<string> {
  const key = await importKey(privateKeyPem);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `sig="${toBase64(signature)}", keyid="${keyId}"`;
}

function importKey(pem: string): Promise<CryptoKey> {
  let key = keyCache.get(pem);
  if (!key) {
    key = crypto.subtle.importKey("pkcs8", toPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(pem, key);
  }
  return key;
}

/**
 * Expo's `codesigning:generate` writes a PKCS#1 key ("BEGIN RSA PRIVATE KEY"),
 * and Web Crypto only imports PKCS#8, so wrap PKCS#1 in the PKCS#8 envelope.
 */
function toPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const der = fromBase64(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return der;
  const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const body = [0x02, 0x01, 0x00, ...rsaAlgorithm, 0x04, ...derLength(der.length), ...der];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
