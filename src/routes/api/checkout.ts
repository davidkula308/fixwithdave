import { createFileRoute } from "@tanstack/react-router";

import { isValidReceiptEmail, parseUsdAmount } from "@/lib/payment-validation";
import { resolveCheckoutServicePrice } from "@/lib/service-pricing";

const CHECKOUT_API_URL = "https://api.bachs.io/v1/checkout-sessions";

// Bachs rejects success_url/cancel_url that point at a machine-only address,
// so redirect links are only sent when the site is reachable from the internet.
function isPubliclyReachable(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname;
  return host !== "localhost" && !host.endsWith(".localhost") && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== "[::1]";
}

export const Route = createFileRoute("/api/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const origin = request.headers.get("origin");
        const requestOrigin = new URL(request.url).origin;
        if (!origin || origin !== requestOrigin) {
          return Response.json({ error: "Please restart checkout from the TechTally website." }, { status: 403 });
        }

        if (!request.headers.get("content-type")?.includes("application/json")) {
          return Response.json({ error: "Invalid checkout request." }, { status: 415 });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid checkout request." }, { status: 400 });
        }

        if (body === null || typeof body !== "object") {
          return Response.json({ error: "Invalid checkout request." }, { status: 400 });
        }

        const input = body as { amount?: unknown; email?: unknown; serviceId?: unknown };
        if (!isValidReceiptEmail(input.email)) {
          return Response.json({ error: "Enter a valid receipt email." }, { status: 400 });
        }

        let amount: string | null = null;
        if (typeof input.serviceId === "string") {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: service, error } = await supabaseAdmin
            .from("techtally_services")
            .select("price_usd, show_price, is_visible")
            .eq("id", input.serviceId)
            .maybeSingle();
          if (error || !service?.is_visible || !service.show_price) {
            return Response.json({ error: "This service does not have a fixed price." }, { status: 400 });
          }
          amount = resolveCheckoutServicePrice(service);
          if (!amount) return Response.json({ error: "This service does not have a valid fixed price." }, { status: 400 });
        } else {
          amount = parseUsdAmount(input.amount);
          if (!amount) return Response.json({ error: "Enter a valid amount." }, { status: 400 });
        }

        const apiKey = process.env["BACHS_API_KEY"];
        if (!apiKey) {
          console.error("Bachs payment credentials are unavailable.");
          return Response.json({ error: "Payments are temporarily unavailable. Please try again later." }, { status: 503 });
        }

        const payload: Record<string, unknown> = {
          pricing: { amount, currency: "USD" },
          customer: { email: input.email.trim() },
        };
        if (typeof input.serviceId === "string") {
          payload["metadata"] = { service_id: input.serviceId };
        }
        if (isPubliclyReachable(requestOrigin)) {
          payload["success_url"] = `${requestOrigin}/?payment=complete`;
          payload["cancel_url"] = `${requestOrigin}/?payment=cancelled`;
        }

        let upstream: Response;
        try {
          upstream = await fetch(CHECKOUT_API_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify(payload),
          });
        } catch (error) {
          console.error("Bachs checkout request failed:", error);
          return Response.json({ error: "Could not start checkout. Please try again." }, { status: 502 });
        }

        if (!upstream.ok) {
          const errorBody = await upstream.text();
          console.error(`Bachs checkout failed [${upstream.status}]: ${errorBody}`);
          return Response.json({ error: "Could not start checkout. Please try again." }, { status: 502 });
        }

        let checkout: { checkout_url?: unknown; error?: unknown; detail?: unknown };
        try {
          checkout = (await upstream.json()) as typeof checkout;
        } catch (error) {
          console.error("Bachs checkout returned an unreadable response:", error);
          return Response.json({ error: "Could not start checkout. Please try again." }, { status: 502 });
        }

        if (checkout.error || typeof checkout.checkout_url !== "string") {
          console.error("Bachs checkout response did not include a checkout URL.", checkout.detail ?? checkout.error);
          return Response.json({ error: "Could not start checkout. Please try again." }, { status: 502 });
        }

        let checkoutUrl: URL;
        try {
          checkoutUrl = new URL(checkout.checkout_url);
        } catch {
          return Response.json({ error: "Could not start checkout. Please try again." }, { status: 502 });
        }

        if (checkoutUrl.origin !== "https://checkout.bachs.io") {
          console.error("Bachs checkout returned an unexpected checkout origin.");
          return Response.json({ error: "Could not start checkout. Please try again." }, { status: 502 });
        }

        return Response.json({ checkoutUrl: checkoutUrl.toString() }, {
          headers: { "Cache-Control": "no-store" },
        });
      },
    },
  },
});
