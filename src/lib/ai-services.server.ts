// Server-only Lovable AI helpers for drafting TechTally services and their card images.
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, Output, streamText } from "ai";

import type { AiIdeaSource, AiTheme } from "./service-categories";

const GATEWAY_BASE_URL = "https://ai.gateway.lovable.dev/v1";
const TEXT_MODEL = "openai/gpt-6-astra";
const IMAGE_MODEL = "openai/gpt-image-2.5-sunburst";
const RUN_ID_HEADER = "X-Lovable-AIG-Run-ID";

export class AiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function findStatus(error: unknown, depth = 0): number | null {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const record = error as { statusCode?: unknown; status?: unknown; cause?: unknown; lastError?: unknown };
  if (typeof record.statusCode === "number") return record.statusCode;
  if (typeof record.status === "number") return record.status;
  return findStatus(record.lastError, depth + 1) ?? findStatus(record.cause, depth + 1);
}

export function friendlyAiError(status: number | null): AiRequestError {
  if (status === 402) return new AiRequestError(402, "Your AI credits have run out. Add credits to your workspace, then try again.");
  if (status === 429) return new AiRequestError(429, "Too many AI requests right now. Wait a minute, then try again.");
  if (status === 403) return new AiRequestError(403, "AI is not available for this workspace right now.");
  return new AiRequestError(502, "The AI could not finish this request. Please try again.");
}

function createRunIdFetch() {
  let runId: string | undefined;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (runId && !headers.has(RUN_ID_HEADER)) headers.set(RUN_ID_HEADER, runId);
    const response = await fetch(input, { ...init, headers });
    runId ??= response.headers.get(RUN_ID_HEADER)?.trim() || undefined;
    return response;
  };
}

export type ServiceDraft = { title: string; description: string; image_prompt: string };

const draftSchema = jsonSchema<{ services: { title: string; lines: string[]; image_scene: string }[] }>({
  type: "object",
  additionalProperties: false,
  required: ["services"],
  properties: {
    services: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "lines", "image_scene"],
        properties: {
          title: { type: "string" },
          lines: { type: "array", items: { type: "string" } },
          image_scene: { type: "string" },
        },
      },
    },
  },
});

const THEME_TEXT: Record<AiTheme, string> = {
  gaming: "PC gaming services (game installs, game performance tuning, controllers, mods, launchers and similar).",
  "storage-fix": "storage and disk services (cleanup, recovery, SSD upgrades, backups, disk health and similar).",
  general: "any useful PC support or software service — pick a varied, practical mix.",
};

export async function draftServices(options: {
  apiKey: string;
  count: number;
  destinationLabel: string;
  theme: AiTheme;
  ideaSource: AiIdeaSource;
  idea: string;
  existingTitles: string[];
  signal: AbortSignal;
}): Promise<ServiceDraft[]> {
  const provider = createOpenAI({
    baseURL: GATEWAY_BASE_URL,
    apiKey: options.apiKey,
    headers: { "Lovable-API-Key": options.apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: createRunIdFetch(),
  });

  const instructions = [
    "You write service listings for TechTally, a general-purpose PC support and software services business.",
    "Audience: everyday customers and businesses. Never mention students, schools, universities, or any person's name.",
    "Each service needs: a short title (max 40 characters, no emoji); 3 or 4 short benefit lines (each max 45 characters, no bullets or numbering); and image_scene, one sentence describing a simple visual scene for the card illustration with no text or logos in it.",
    "Do not invent prices, guarantees, or brand partnerships.",
  ].join("\n");

  const ideaText =
    options.ideaSource === "described" && options.idea.trim()
      ? `Base them on this request from the owner: "${options.idea.trim().slice(0, 600)}".`
      : "Invent services the business does not already offer.";

  const prompt = [
    `Write exactly ${options.count} new service listing(s) for the "${options.destinationLabel}" section of the website.`,
    `Focus: ${THEME_TEXT[options.theme]}`,
    ideaText,
    `Already offered (do not repeat or closely copy): ${options.existingTitles.slice(0, 80).join("; ") || "none"}.`,
  ].join("\n");

  try {
    const result = streamText({
      model: provider.responses(TEXT_MODEL),
      instructions,
      messages: [{ role: "user", content: prompt }],
      output: Output.object({ schema: draftSchema }),
      abortSignal: options.signal,
      maxRetries: 0,
      providerOptions: {
        openai: {
          forceReasoning: true,
          reasoningEffort: "low",
          reasoningSummary: "auto",
          store: false,
          include: ["reasoning.encrypted_content"],
        },
      },
    });
    const output = await result.output;
    const existing = new Set(options.existingTitles.map((title) => title.toLowerCase()));
    return output.services
      .map((service) => ({
        title: service.title.replace(/\s+/g, " ").trim().slice(0, 100),
        description: service.lines
          .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 6)
          .join("\n"),
        image_prompt: service.image_scene.trim().slice(0, 400),
      }))
      .filter((service) => service.title && service.description && !existing.has(service.title.toLowerCase()))
      .slice(0, options.count);
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    console.error("AI service drafting failed:", error);
    throw friendlyAiError(findStatus(error));
  }
}

export function buildServiceImagePrompt(title: string, scene: string): string {
  return [
    `Website service card illustration for a PC support business. Service: "${title}".`,
    scene ? `Scene: ${scene}` : "",
    "Style: clean flat modern tech illustration on a vivid royal-blue background, white and light-blue devices and interface panels, soft shadows, centered subject, wide landscape framing.",
    "Absolutely no words, letters, numbers, logos, watermarks, or brand names anywhere in the image.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function requestServiceImage(apiKey: string, prompt: string, stream: boolean, signal: AbortSignal) {
  return fetch(`${GATEWAY_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      size: "1536x1024",
      quality: "medium",
      ...(stream ? { stream: true, partial_images: 1 } : {}),
    }),
    signal,
  });
}
