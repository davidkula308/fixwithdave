// Admin code rules and salted PBKDF2 hashing, shared by the admin API and its tests.

// Cloudflare Workers reject PBKDF2 above 100,000 iterations, so stored codes use exactly that.
export const PBKDF2_ITERATIONS = 100_000;
export const MIN_PBKDF2_ITERATIONS = 10_000;
export const ADMIN_CODE_PATTERN = /^\d{4,12}$/;
export const ADMIN_CODE_NAMES = ["primary", "secondary"] as const;
export type AdminCodeName = (typeof ADMIN_CODE_NAMES)[number];

export function isAdminCodeName(value: unknown): value is AdminCodeName {
  return typeof value === "string" && (ADMIN_CODE_NAMES as readonly string[]).includes(value);
}

export function adminCodeLabel(name: string): string {
  return name === "primary" ? "Main code" : name === "secondary" ? "Backup code" : name;
}

/** Returns an error message for an unacceptable new code, or null when it can be saved. */
export function validateNewAdminCode(code: unknown, confirmation: unknown): string | null {
  if (typeof code !== "string" || !ADMIN_CODE_PATTERN.test(code)) {
    return "The new code must be 4 to 12 digits.";
  }
  if (code !== confirmation) return "The two new codes do not match.";
  return null;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function derive(code: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
      key,
      256,
    ),
  );
}

export async function hashAdminCode(
  code: string,
): Promise<{ salt: string; code_hash: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(code, salt, PBKDF2_ITERATIONS);
  return { salt: encodeBase64Url(salt), code_hash: encodeBase64Url(bits), iterations: PBKDF2_ITERATIONS };
}

export async function adminCodeMatches(
  code: string,
  row: { salt: string; code_hash: string; iterations: number },
): Promise<boolean> {
  if (
    !Number.isInteger(row.iterations) ||
    row.iterations < MIN_PBKDF2_ITERATIONS ||
    row.iterations > PBKDF2_ITERATIONS
  ) {
    return false;
  }
  const salt = decodeBase64Url(row.salt);
  const expected = decodeBase64Url(row.code_hash);
  if (!salt || !expected) return false;
  const bits = await derive(code, salt, row.iterations);
  if (expected.length !== bits.length) return false;
  let difference = 0;
  for (let index = 0; index < bits.length; index += 1) {
    difference |= (bits[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}
