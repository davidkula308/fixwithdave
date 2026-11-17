import { createFileRoute } from "@tanstack/react-router";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

type ServiceRow = Tables<"techtally_services">;
type ServiceSave = Pick<ServiceRow, "title" | "description" | "image_data" | "image_alt" | "show_price" | "price_usd"> & {
  id?: string;
};

const SESSION_COOKIE = "techtally_admin_session";
const SESSION_SECONDS = 60 * 60 * 12;
const MAX_IMAGE_LENGTH = 5_600_000;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmacSessionToken(token: string): Promise<string | null> {
  const secret = process.env["TECHTALLY_ADMIN_SESSION_SECRET"];
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token))));
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const entry = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function withSessionCookie(response: Response, token: string, request: Request): Response {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${SESSION_SECONDS}${secure}`,
  );
  return response;
}

function clearSessionCookie(response: Response, request: Request): Response {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  response.headers.append("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure}`);
  return response;
}

async function verifyAdminSession(request: Request): Promise<boolean> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length < 32) return false;
  const tokenHash = await hmacSessionToken(token);
  if (!tokenHash) return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("techtally_admin_sessions")
    .select("id")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return !error && data !== null;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function isImageData(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IMAGE_LENGTH &&
    (value === "" || /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value));
}

async function pinMatches(pin: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("techtally_admin_codes")
    .select("salt, code_hash, iterations")
    .eq("code_name", "primary")
    .maybeSingle();
  if (error || !data || !Number.isInteger(data.iterations) || data.iterations < 100_000 || data.iterations > 1_000_000) {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(data.salt), iterations: data.iterations },
    key,
    256,
  ));
  const expected = decodeBase64Url(data.code_hash);
  if (!expected || expected.length !== bits.length) return false;
  let difference = 0;
  for (let index = 0; index < bits.length; index += 1) difference |= bits[index]! ^ expected[index]!;
  return difference === 0;
}

async function isRateLimited(request: Request): Promise<boolean> {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const agent = request.headers.get("user-agent") ?? "unknown";
  const attemptKey = encodeBase64Url(await sha256(`${address}|${agent}`));
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { count, error } = await supabaseAdmin
    .from("techtally_admin_attempts")
    .select("id", { count: "exact", head: true })
    .eq("attempt_key", attemptKey)
    .gt("attempted_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());
  return !error && (count ?? 0) >= 8;
}

async function recordFailedAttempt(request: Request): Promise<void> {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const agent = request.headers.get("user-agent") ?? "unknown";
  const attemptKey = encodeBase64Url(await sha256(`${address}|${agent}`));
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("techtally_admin_attempts").insert({ attempt_key: attemptKey });
  if (error) console.error("Could not record an admin sign-in attempt.", error);
}

async function listServices() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin
    .from("techtally_services")
    .select("id, service_key, title, description, image_data, image_alt, items, highlight, tag, price_usd, show_price, is_visible, sort_order")
    .order("sort_order", { ascending: true });
}

export const Route = createFileRoute("/api/admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          if (!(await verifyAdminSession(request))) {
            return Response.json({ error: "Admin sign-in required." }, { status: 401, headers: { "Cache-Control": "no-store" } });
          }
          const { data, error } = await listServices();
          if (error) throw error;
          return Response.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          console.error("Admin service list could not be loaded:", error);
          return Response.json({ error: "Could not load the service list." }, { status: 503 });
        }
      },
      POST: async ({ request }) => {
        if (!sameOrigin(request)) return Response.json({ error: "Please restart this action from TechTally." }, { status: 403 });
        if (!request.headers.get("content-type")?.includes("application/json")) {
          return Response.json({ error: "Invalid request." }, { status: 415 });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid request." }, { status: 400 });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return Response.json({ error: "Invalid request." }, { status: 400 });
        }
        const input = body as Record<string, unknown>;

        if (input["action"] === "login") {
          if (await isRateLimited(request)) {
            return Response.json({ error: "Too many attempts. Please try again in 15 minutes." }, { status: 429 });
          }
          const pin = input["pin"];
          if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin) || !(await pinMatches(pin))) {
            await recordFailedAttempt(request);
            return Response.json({ error: "That admin code is not correct." }, { status: 401 });
          }
          const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
          const token = encodeBase64Url(tokenBytes);
          const tokenHash = await hmacSessionToken(token);
          if (!tokenHash) return Response.json({ error: "Admin sign-in is temporarily unavailable." }, { status: 503 });
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { error } = await supabaseAdmin.from("techtally_admin_sessions").insert({
            token_hash: tokenHash,
            expires_at: new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(),
          });
          if (error) throw error;
          return withSessionCookie(Response.json({ signedIn: true }, { headers: { "Cache-Control": "no-store" } }), token, request);
        }

        if (!(await verifyAdminSession(request))) {
          return Response.json({ error: "Your admin session has expired. Please sign in again." }, { status: 401 });
        }

        if (input["action"] !== "save-service") return Response.json({ error: "Unsupported admin action." }, { status: 400 });
        const title = input["title"];
        const description = input["description"];
        const imageData = input["image_data"];
        const showPrice = input["show_price"];
        const imageAlt = input["image_alt"];
        const id = input["id"];
        const parsedPrice = input["price_usd"] === "" || input["price_usd"] == null
          ? null
          : typeof input["price_usd"] === "string" && /^\d+(?:\.\d{1,2})?$/.test(input["price_usd"])
            ? Number(input["price_usd"])
            : Number.NaN;

        if (typeof title !== "string" || !title.trim() || title.trim().length > 100 ||
            typeof description !== "string" || description.length > 2000 ||
            typeof showPrice !== "boolean" || typeof imageAlt !== "string" || imageAlt.length > 180 ||
            !isImageData(imageData) || (id !== undefined && typeof id !== "string") ||
            (showPrice && (parsedPrice === null || !Number.isFinite(parsedPrice) || parsedPrice <= 0 || !/^\d+(?:\.\d{1,2})?$/.test(String(input["price_usd"])))) {
          return Response.json({ error: "Enter a title and a valid price, description, and image." }, { status: 400 });
        }

        const descriptionLines = description.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const update = {
          title: title.trim(),
          description: description.trim(),
          image_data: imageData,
          image_alt: imageAlt.trim() || title.trim(),
          items: descriptionLines,
          show_price: showPrice,
          price_usd: showPrice ? parsedPrice : null,
          updated_at: new Date().toISOString(),
        };

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          if (id) {
            const { error } = await supabaseAdmin.from("techtally_services").update(update).eq("id", id);
            if (error) throw error;
          } else {
            const { data: existing } = await listServices();
            const maxOrder = Math.max(0, ...(existing ?? []).map((service) => service.sort_order));
            const insert: TablesInsert<"techtally_services"> = {
              ...update,
              service_key: null,
              is_visible: true,
              sort_order: maxOrder + 10,
              tag: "Available Now",
              highlight: null,
            };
            const { error } = await supabaseAdmin.from("techtally_services").insert(insert);
            if (error) throw error;
          }
          const { data, error } = await listServices();
          if (error) throw error;
          return Response.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          console.error("Admin could not save a service:", error);
          return Response.json({ error: "Could not save those changes. Please try again." }, { status: 500 });
        }
      },
    },
  },
});