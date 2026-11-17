import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { labelForEventType, summarizeWebhookEvent, verifyBachsSignature } from "./bachs-webhook";

const secret = "whsec_test_secret";
const body = JSON.stringify({ id: "evt_1", type: "checkout.completed", data: { amount: "8.00" } });
const now = 1_800_000_000;
const sign = (key: string, ts: number) => createHmac("sha256", key).update(`${ts}.${body}`).digest("hex");

describe("Bachs webhook signatures", () => {
  it("accepts a delivery signed with the endpoint secret", async () => {
    const header = `t=${now},v1=${sign(secret, now)}`;
    expect(await verifyBachsSignature(body, { v2: header }, [secret], now)).toBe(true);
  });

  it("accepts any matching v1 value during a secret rotation", async () => {
    const header = `t=${now},v1=${sign("whsec_old", now)},v1=${sign(secret, now)}`;
    expect(await verifyBachsSignature(body, { v2: header }, [secret], now)).toBe(true);
  });

  it("rejects a delivery signed with a different secret", async () => {
    const header = `t=${now},v1=${sign("whsec_attacker", now)}`;
    expect(await verifyBachsSignature(body, { v2: header }, [secret], now)).toBe(false);
  });

  it("rejects a changed body", async () => {
    const header = `t=${now},v1=${sign(secret, now)}`;
    expect(await verifyBachsSignature(body.replace("8.00", "1.00"), { v2: header }, [secret], now)).toBe(false);
  });

  it("rejects deliveries older than five minutes", async () => {
    const old = now - 301;
    const header = `t=${old},v1=${sign(secret, old)}`;
    expect(await verifyBachsSignature(body, { v2: header }, [secret], now)).toBe(false);
  });

  it("supports the original signature and timestamp headers", async () => {
    const headers = { legacy: sign(secret, now), timestamp: String(now) };
    expect(await verifyBachsSignature(body, headers, [secret], now)).toBe(true);
  });

  it("rejects deliveries with no signature", async () => {
    expect(await verifyBachsSignature(body, {}, [secret], now)).toBe(false);
  });
});

describe("Bachs webhook event summaries", () => {
  it("pulls the amount, currency, email and status from a completed checkout", () => {
    const summary = summarizeWebhookEvent({
      id: "evt_7f6e",
      type: "checkout.completed",
      created_at: "2026-07-20T09:15:00.000000+00:00",
      data: { checkout_id: "chk_1", payment_status: "paid", amount: "19.00", currency: "USD", customer_details: { email: "jane@example.com" } },
    });
    expect(summary).toMatchObject({ event_id: "evt_7f6e", event_type: "checkout.completed", amount: "19.00", currency: "USD", customer_email: "jane@example.com", status: "paid", reference: "chk_1" });
  });

  it("rejects events without an id or type", () => {
    expect(summarizeWebhookEvent({ type: "checkout.completed" })).toBeNull();
    expect(summarizeWebhookEvent({ id: "evt_1" })).toBeNull();
  });

  it("labels the requested event types in plain words", () => {
    expect(labelForEventType("collection.succeeded")).toBe("Payment succeeded");
    expect(labelForEventType("payout.failed")).toBe("Payout failed");
    expect(labelForEventType("refund.paid")).toBe("Refund paid");
  });
});
