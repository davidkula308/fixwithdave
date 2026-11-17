import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

function createPublicCatalogClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("Public catalog is unavailable.");

  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (key.startsWith("sb_") && headers.get("Authorization") === `Bearer ${key}`) {
          headers.delete("Authorization");
        }
        headers.set("apikey", key);
        return fetch(input, { ...init, headers });
      },
    },
  });
}

export const Route = createFileRoute("/api/catalog")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const client = createPublicCatalogClient();
          const [servicesResult, tabsResult] = await Promise.all([
            client
              .from("techtally_services")
              .select("id, service_key, title, description, image_data, image_alt, items, highlight, tag, price_usd, show_price, sort_order, category")
              .eq("is_visible", true)
              .order("sort_order", { ascending: true }),
            client.from("techtally_tabs").select("slug, label, sort_order").order("sort_order", { ascending: true }),
          ]);
          if (servicesResult.error) throw servicesResult.error;
          if (tabsResult.error) throw tabsResult.error;
          return Response.json(
            { services: servicesResult.data ?? [], tabs: tabsResult.data ?? [] },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          console.error("Public service catalog could not be loaded:", error);
          return Response.json({ error: "Services are temporarily unavailable." }, { status: 503 });
        }
      },
    },
  },
});