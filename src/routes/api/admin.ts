import { createFileRoute } from "@tanstack/react-router";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";
import {
  adminCodeLabel,
  adminCodeMatches,
  encodeBase64Url,
  hashAdminCode,
  isAdminCodeName,
  validateNewAdminCode,
} from "@/lib/admin-codes";
import { BUILTIN_TABS, BUILTIN_TAB_SLUGS, clampServiceCount, cleanTabLabel, slugifyTabLabel, type AiIdeaSource, type AiTheme } from "@/lib/service-categories";

type ServiceRow = Tables<"techtally_services">;

const SESSION_COOKIE = "techtally_admin_session";
const SESSION_SECONDS = 60 * 60 * 12;
const MAX_IMAGE_LENGTH = 5_600_000;

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
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token))),
  );
}

function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const entry = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return null;
  }
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
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure}`,
  );
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
  return (
    typeof value === "string" &&
    value.length <= MAX_IMAGE_LENGTH &&
    (value === "" || /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
  );
}

async function pinMatches(pin: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: rows, error } = await supabaseAdmin
    .from("techtally_admin_codes")
    .select("salt, code_hash, iterations");
  if (error || !rows) return false;
  for (const row of rows) {
    if (await adminCodeMatches(pin, row)) return true;
  }
  return false;
}

async function currentTokenHash(request: Request): Promise<string | null> {
  const token = getCookie(request, SESSION_COOKIE);
  return token ? hmacSessionToken(token) : null;
}

async function securityOverview(request: Request) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: codes, error: codesError }, { data: sessions, error: sessionsError }] = await Promise.all([
    supabaseAdmin.from("techtally_admin_codes").select("code_name, updated_at").order("code_name"),
    supabaseAdmin.from("techtally_admin_sessions").select("token_hash").gt("expires_at", new Date().toISOString()),
  ]);
  if (codesError) throw codesError;
  if (sessionsError) throw sessionsError;
  const mine = await currentTokenHash(request);
  return {
    codes: (codes ?? []).map((code) => ({ code_name: code.code_name, label: adminCodeLabel(code.code_name), updated_at: code.updated_at })),
    other_sessions: (sessions ?? []).filter((session) => session.token_hash !== mine).length,
  };
}

// Ends every admin sign-in except the one making this request.
async function revokeOtherSessions(request: Request): Promise<void> {
  const mine = await currentTokenHash(request);
  if (!mine) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("techtally_admin_sessions").delete().neq("token_hash", mine);
  if (error) throw error;
}

// Checks a code typed to confirm a security change, counting wrong guesses like sign-in attempts.
async function confirmCode(
  request: Request,
  pin: unknown,
  row?: { salt: string; code_hash: string; iterations: number },
): Promise<Response | null> {
  if (await isRateLimited(request)) {
    return Response.json({ error: "Too many attempts. Please try again in 15 minutes." }, { status: 429 });
  }
  const ok =
    typeof pin === "string" &&
    /^\d{4,12}$/.test(pin) &&
    (row ? await adminCodeMatches(pin, row) : await pinMatches(pin));
  if (!ok) {
    await recordFailedAttempt(request);
    return Response.json({ error: "The current code is not correct." }, { status: 403 });
  }
  return null;
}

async function handleSecurity(input: Record<string, unknown>, request: Request): Promise<Response> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const action = input["action"];

  if (action === "revoke-sessions") {
    await revokeOtherSessions(request);
    return Response.json(await securityOverview(request), { headers: { "Cache-Control": "no-store" } });
  }

  const codeName = input["code_name"];
  if (!isAdminCodeName(codeName)) return Response.json({ error: "Choose which code to change." }, { status: 400 });
  const { data: rows, error } = await supabaseAdmin
    .from("techtally_admin_codes")
    .select("code_name, salt, code_hash, iterations");
  if (error) throw error;
  const target = (rows ?? []).find((row) => row.code_name === codeName);
  const others = (rows ?? []).filter((row) => row.code_name !== codeName);

  if (action === "change-code") {
    const invalid = validateNewAdminCode(input["new_pin"], input["confirm_pin"]);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    // Changing an existing code needs that code; adding a missing one needs any current code.
    const denied = await confirmCode(request, input["current_pin"], target);
    if (denied) return denied;
    const newPin = input["new_pin"] as string;
    for (const other of others) {
      if (await adminCodeMatches(newPin, other)) {
        return Response.json({ error: "Your other admin code already uses those digits. Choose different ones." }, { status: 400 });
      }
    }
    const hashed = await hashAdminCode(newPin);
    const { error: saveError } = await supabaseAdmin
      .from("techtally_admin_codes")
      .upsert({ code_name: codeName, ...hashed, updated_at: new Date().toISOString() }, { onConflict: "code_name" });
    if (saveError) throw saveError;
    await revokeOtherSessions(request);
    return Response.json(await securityOverview(request), { headers: { "Cache-Control": "no-store" } });
  }

  if (action === "remove-code") {
    if (!target) return Response.json({ error: "That code is already removed." }, { status: 404 });
    if (others.length === 0) {
      return Response.json({ error: "Keep at least one admin code, or you will be locked out." }, { status: 400 });
    }
    const denied = await confirmCode(request, input["current_pin"]);
    if (denied) return denied;
    const { error: deleteError } = await supabaseAdmin.from("techtally_admin_codes").delete().eq("code_name", codeName);
    if (deleteError) throw deleteError;
    await revokeOtherSessions(request);
    return Response.json(await securityOverview(request), { headers: { "Cache-Control": "no-store" } });
  }

  return Response.json({ error: "Unsupported admin action." }, { status: 400 });
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
  return Boolean(error) || (count ?? 0) >= 8;
}

async function recordFailedAttempt(request: Request): Promise<void> {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const agent = request.headers.get("user-agent") ?? "unknown";
  const attemptKey = encodeBase64Url(await sha256(`${address}|${agent}`));
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("techtally_admin_attempts")
    .insert({ attempt_key: attemptKey });
  if (error) console.error("Could not record an admin sign-in attempt.", error);
}

async function listServices() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin
    .from("techtally_services")
    .select(
      "id, service_key, title, description, image_data, image_alt, items, highlight, tag, price_usd, show_price, is_visible, sort_order, category",
    )
    .order("sort_order", { ascending: true });
}

async function listTabs() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin
    .from("techtally_tabs")
    .select("id, slug, label, sort_order")
    .order("sort_order", { ascending: true });
}

// Resolves the tab a service is saved under, creating a new custom tab when asked.
async function resolveCategory(category: unknown, tabLabel: unknown): Promise<string | null> {
  if (typeof category !== "string") return null;
  if (BUILTIN_TAB_SLUGS.has(category)) return category;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: existing } = await supabaseAdmin.from("techtally_tabs").select("slug").eq("slug", category).maybeSingle();
  if (existing) return existing.slug;
  const label = cleanTabLabel(tabLabel);
  if (!label || slugifyTabLabel(label) !== category) return null;
  const { data: tabs } = await listTabs();
  const maxOrder = Math.max(100, ...(tabs ?? []).map((tab) => tab.sort_order));
  const { error } = await supabaseAdmin
    .from("techtally_tabs")
    .upsert({ slug: category, label, sort_order: maxOrder + 10 }, { onConflict: "slug", ignoreDuplicates: true });
  if (error) throw error;
  return category;
}

async function categoryLabel(category: string): Promise<string | null> {
  const builtin = BUILTIN_TABS.find((tab) => tab.slug === category);
  if (builtin) return builtin.label;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("techtally_tabs").select("label").eq("slug", category).maybeSingle();
  return data?.label ?? null;
}

async function handleAiDraft(input: Record<string, unknown>, request: Request): Promise<Response> {
  const count = clampServiceCount(input["count"]);
  const theme = input["theme"];
  const ideaSource = input["idea_source"];
  const idea = typeof input["idea"] === "string" ? input["idea"] : "";
  const category = input["category"];
  if (
    count === null ||
    (theme !== "gaming" && theme !== "storage-fix" && theme !== "general") ||
    (ideaSource !== "random" && ideaSource !== "described") ||
    idea.length > 600 ||
    typeof category !== "string"
  ) {
    return Response.json({ error: "Choose how many services, a tab, and a type of service." }, { status: 400 });
  }
  if (ideaSource === "described" && !idea.trim()) {
    return Response.json({ error: "Describe the services you want, or choose random ideas." }, { status: 400 });
  }
  const label = (await categoryLabel(category)) ?? cleanTabLabel(input["tab_label"]);
  if (!label) return Response.json({ error: "Choose a tab, or give the new tab a name." }, { status: 400 });

  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return Response.json({ error: "AI is not set up for this site yet." }, { status: 503 });

  const { data: services } = await listServices();
  const { draftServices, AiRequestError } = await import("@/lib/ai-services.server");
  try {
    const drafts = await draftServices({
      apiKey,
      count,
      destinationLabel: label,
      theme: theme as AiTheme,
      ideaSource: ideaSource as AiIdeaSource,
      idea,
      existingTitles: (services ?? []).map((service) => service.title),
      signal: request.signal,
    });
    if (drafts.length === 0) {
      return Response.json({ error: "The AI did not come up with new services. Try again or describe what you want." }, { status: 502 });
    }
    return Response.json({ drafts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AiRequestError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

async function handleAiImage(input: Record<string, unknown>, request: Request): Promise<Response> {
  const title = input["title"];
  const scene = typeof input["image_prompt"] === "string" ? input["image_prompt"] : "";
  if (typeof title !== "string" || !title.trim() || title.length > 100 || scene.length > 400) {
    return Response.json({ error: "Add a service title before making an image." }, { status: 400 });
  }
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return Response.json({ error: "AI is not set up for this site yet." }, { status: 503 });
  const { buildServiceImagePrompt, requestServiceImage, friendlyAiError } = await import("@/lib/ai-services.server");
  const stream = input["stream"] !== false;
  let upstream: Response;
  try {
    upstream = await requestServiceImage(apiKey, buildServiceImagePrompt(title.trim(), scene.trim()), stream, request.signal);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("AI image request failed:", error);
    const friendly = friendlyAiError(null);
    return Response.json({ error: friendly.message }, { status: friendly.status });
  }
  if (!upstream.ok) {
    console.error(`AI image request failed [${upstream.status}]: ${await upstream.text().catch(() => "")}`);
    const friendly = friendlyAiError(upstream.status);
    return Response.json({ error: friendly.message }, { status: friendly.status });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-cache",
    },
  });
}

export const Route = createFileRoute("/api/admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          if (!(await verifyAdminSession(request))) {
            return Response.json(
              { error: "Admin sign-in required." },
              { status: 401, headers: { "Cache-Control": "no-store" } },
            );
          }
          if (new URL(request.url).searchParams.get("view") === "tabs") {
            const { data, error } = await listTabs();
            if (error) throw error;
            return Response.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
          }
          if (new URL(request.url).searchParams.get("view") === "security") {
            return Response.json(await securityOverview(request), { headers: { "Cache-Control": "no-store" } });
          }
          if (new URL(request.url).searchParams.get("view") === "payment-events") {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { data, error } = await supabaseAdmin
              .from("techtally_payment_events")
              .select("id, event_id, event_type, amount, currency, customer_email, status, reference, event_created_at, received_at")
              .order("received_at", { ascending: false })
              .limit(100);
            if (error) throw error;
            return Response.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
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
        try {
          return await handlePost(request);
        } catch (error) {
          console.error("Admin request failed:", error);
          return Response.json(
            { error: "Something went wrong. Please try again." },
            { status: 500 },
          );
        }
      },
    },
  },
});

async function handlePost(request: Request): Promise<Response> {
  if (!sameOrigin(request))
    return Response.json({ error: "Please restart this action from TechTally." }, { status: 403 });
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return Response.json({ error: "Invalid request." }, { status: 415 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMAGE_LENGTH + 100_000) {
    return Response.json(
      { error: "That image is too large. Choose an image up to 4 MB." },
      { status: 413 },
    );
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
      return Response.json(
        { error: "Too many attempts. Please try again in 15 minutes." },
        { status: 429 },
      );
    }
    const pin = input["pin"];
    if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin) || !(await pinMatches(pin))) {
      await recordFailedAttempt(request);
      return Response.json({ error: "That admin code is not correct." }, { status: 401 });
    }
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = encodeBase64Url(tokenBytes);
    const tokenHash = await hmacSessionToken(token);
    if (!tokenHash)
      return Response.json({ error: "Admin sign-in is temporarily unavailable." }, { status: 503 });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("techtally_admin_sessions").insert({
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(),
    });
    if (error) throw error;
    return withSessionCookie(
      Response.json({ signedIn: true }, { headers: { "Cache-Control": "no-store" } }),
      token,
      request,
    );
  }

  if (input["action"] === "logout") {
    const token = getCookie(request, SESSION_COOKIE);
    const tokenHash = token ? await hmacSessionToken(token) : null;
    if (tokenHash) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await supabaseAdmin
        .from("techtally_admin_sessions")
        .delete()
        .eq("token_hash", tokenHash);
      if (error) console.error("Could not end an admin session.", error);
    }
    return clearSessionCookie(
      Response.json({ signedOut: true }, { headers: { "Cache-Control": "no-store" } }),
      request,
    );
  }

  if (!(await verifyAdminSession(request))) {
    return Response.json(
      { error: "Your admin session has expired. Please sign in again." },
      { status: 401 },
    );
  }

  if (input["action"] === "ai-draft-services") return handleAiDraft(input, request);
  if (input["action"] === "ai-image") return handleAiImage(input, request);
  if (input["action"] === "change-code" || input["action"] === "remove-code" || input["action"] === "revoke-sessions") {
    return handleSecurity(input, request);
  }

  if (input["action"] !== "save-service")
    return Response.json({ error: "Unsupported admin action." }, { status: 400 });
  const title = input["title"];
  const description = input["description"];
  const imageData = input["image_data"];
  const showPrice = input["show_price"];
  const imageAlt = input["image_alt"];
  const id = input["id"];
  const validPrice =
    input["price_usd"] === "" || input["price_usd"] == null
      ? null
      : typeof input["price_usd"] === "string" && /^\d+(?:\.\d{1,2})?$/.test(input["price_usd"])
        ? Number(input["price_usd"])
        : Number.NaN;

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 100 ||
    typeof description !== "string" ||
    description.length > 2000 ||
    typeof showPrice !== "boolean" ||
    typeof imageAlt !== "string" ||
    imageAlt.length > 180 ||
    !isImageData(imageData) ||
    (id !== undefined && typeof id !== "string") ||
    (showPrice && (validPrice === null || Number.isNaN(validPrice) || validPrice <= 0))
  ) {
    return Response.json(
      { error: "Enter a title and a valid price, description, and image." },
      { status: 400 },
    );
  }

  let category: string | null = null;
  if (input["category"] !== undefined) {
    category = await resolveCategory(input["category"], input["tab_label"]);
    if (!category) return Response.json({ error: "Choose a valid tab for this service." }, { status: 400 });
  }

  const descriptionLines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const update = {
    title: title.trim(),
    description: description.trim(),
    image_data: imageData,
    image_alt: imageAlt.trim() || title.trim(),
    items: descriptionLines,
    show_price: showPrice,
    price_usd: showPrice ? validPrice : null,
    updated_at: new Date().toISOString(),
    ...(category ? { category } : {}),
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
    return Response.json(
      { error: "Could not save those changes. Please try again." },
      { status: 500 },
    );
  }
}
