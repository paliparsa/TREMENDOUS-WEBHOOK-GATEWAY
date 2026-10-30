const encoder = new TextEncoder();

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

export async function verifyHmacSha256(
  secret: string,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = await hmacSha256Hex(secret, body);
  return constantTimeEqual(expected.toLowerCase(), match[1].toLowerCase());
}
