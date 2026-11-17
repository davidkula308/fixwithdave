// Verifies Bachs webhook signatures and summarizes events for the Admin Panel.
// Bachs signs HMAC-SHA256 hex of "{timestamp}.{raw_body}" and sends it in
// X-Bachs-Signature-V2 as "t=<ts>,v1=<sig>[,v1=<sig>]" (one v1 per valid secret).

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const WEBHOOK_EVENT_LABELS: Record<string, string> = {
  "checkout.completed": "Checkout completed",
  "checkout.expired": "Checkout expired",
  "collection.succeeded": "Payment succeeded",
  "collection.failed": "Payment failed",
  "dispute.created": "Dispute created",
  "dispute_alert.created": "Dispute alert created",
  "payment_health.updated": "Payment health updated",
  "payment_method.saved": "Payment method saved",
  "payout.created": "Payout created",
  "payout.failed": "Payout failed",
};

export function labelForEventType(type: string): string {
  const known = WEBHOOK_EVENT_LABELS[type];
  if (known) return known;
  const words = type.replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown event";
}

type SignatureHeaders = { v2?: string | null; legacy?: string | null; timestamp?: string | null };

function parseSignatures(headers: SignatureHeaders): { timestamp: number; signatures: string[] } | null {
  if (headers.v2) {
    let timestamp: number | null = null;
    const signatures: string[] = [];
    for (const part of headers.v2.split(",")) {
      const index = part.indexOf("=");
      if (index < 1) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
      if (key === "v1" && value) signatures.push(value.toLowerCase());
    }
    if (timestamp !== null && signatures.length > 0) return { timestamp, signatures };
    return null;
  }
  if (headers.legacy && headers.timestamp && /^\d+$/.test(headers.timestamp)) {
    return { timestamp: Number(headers.timestamp), signatures: [headers.legacy.trim().toLowerCase()] };
  }
  return null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export async function verifyBachsSignature(
  rawBody: string,
  headers: SignatureHeaders,
  secrets: string[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parsed = parseSignatures(headers);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = await hmacHex(secret, `${parsed.timestamp}.${rawBody}`);
    if (parsed.signatures.some((signature) => constantTimeEqual(expected, signature))) return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 320);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export type WebhookEventSummary = {
  event_id: string;
  event_type: string;
  amount: string | null;
  currency: string | null;
  customer_email: string | null;
  status: string | null;
  reference: string | null;
  event_created_at: string | null;
};

export function summarizeWebhookEvent(payload: unknown): WebhookEventSummary | null {
  const event = asRecord(payload);
  if (!event) return null;
  const id = event["id"];
  const type = event["type"];
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return null;
  if (typeof type !== "string" || !/^[a-z0-9_.]{1,100}$/i.test(type)) return null;

  const data = asRecord(event["data"]) ?? {};
  const customer = asRecord(data["customer"]);
  const customerDetails = asRecord(data["customer_details"]);
  const charge = asRecord(data["charge"]);
  const createdAt = typeof event["created_at"] === "string" && !Number.isNaN(Date.parse(event["created_at"]))
    ? new Date(event["created_at"]).toISOString()
    : null;

  return {
    event_id: id,
    event_type: type.toLowerCase(),
    amount: firstString(data["amount"], charge?.["amount"]),
    currency: firstString(data["currency"], charge?.["currency"]),
    customer_email: firstString(customerDetails?.["email"], customer?.["email"], data["email"]),
    status: firstString(data["payment_status"], data["status"], charge?.["status"]),
    reference: firstString(data["reference"], data["checkout_id"], data["payout_id"], data["dispute_id"], data["id"]),
    event_created_at: createdAt,
  };
}
