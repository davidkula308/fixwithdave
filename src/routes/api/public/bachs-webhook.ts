import { createFileRoute } from "@tanstack/react-router";

import type { Json } from "@/integrations/supabase/types";
import { summarizeWebhookEvent, verifyBachsSignature } from "@/lib/bachs-webhook";

const MAX_BODY_BYTES = 1_000_000;

// Receives Bachs webhook deliveries. Every request must carry a valid Bachs
// signature for BACHS_WEBHOOK_SECRET before anything is stored.
export const Route = createFileRoute("/api/public/bachs-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secrets = (process.env["BACHS_WEBHOOK_SECRET"] ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (secrets.length === 0) {
          console.error("Bachs webhook received but BACHS_WEBHOOK_SECRET is not set.");
          return new Response("Webhook receiver is not configured.", { status: 503 });
        }

        const declaredLength = Number(request.headers.get("content-length") ?? 0);
        if (declaredLength > MAX_BODY_BYTES) return new Response("Payload too large.", { status: 413 });

        const rawBody = await request.text();
        if (rawBody.length > MAX_BODY_BYTES) return new Response("Payload too large.", { status: 413 });

        const verified = await verifyBachsSignature(
          rawBody,
          {
            v2: request.headers.get("x-bachs-signature-v2"),
            legacy: request.headers.get("x-bachs-signature"),
            timestamp: request.headers.get("x-bachs-timestamp"),
          },
          secrets,
        );
        if (!verified) return new Response("Invalid signature.", { status: 400 });

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return new Response("Invalid JSON.", { status: 400 });
        }

        const summary = summarizeWebhookEvent(payload);
        if (!summary) return new Response("Invalid event.", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin
          .from("techtally_payment_events")
          .upsert({ ...summary, payload: payload as Json }, { onConflict: "event_id", ignoreDuplicates: true });
        if (error) {
          console.error("Could not store a Bachs webhook event:", error);
          return new Response("Could not record event.", { status: 500 });
        }

        return Response.json({ received: true });
      },
    },
  },
});
