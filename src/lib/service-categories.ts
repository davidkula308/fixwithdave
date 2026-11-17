// Shared rules for which top tab a service appears under.

export const BUILTIN_TABS = [
  { slug: "services", label: "Services" },
  { slug: "gaming", label: "Gaming" },
  { slug: "storage-fix", label: "Storage Fix" },
] as const;

export const BUILTIN_TAB_SLUGS = new Set<string>(BUILTIN_TABS.map((tab) => tab.slug));

export const MIN_AI_SERVICES = 1;
export const MAX_AI_SERVICES = 6;

export type AiTheme = "gaming" | "storage-fix" | "general";
export type AiIdeaSource = "random" | "described";

export function slugifyTabLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function cleanTabLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (trimmed.length < 2 || trimmed.length > 40) return null;
  const slug = slugifyTabLabel(trimmed);
  if (!slug || BUILTIN_TAB_SLUGS.has(slug)) return null;
  return trimmed;
}

export function clampServiceCount(value: unknown): number | null {
  const count = typeof value === "string" ? Number(value) : value;
  if (typeof count !== "number" || !Number.isInteger(count)) return null;
  if (count < MIN_AI_SERVICES || count > MAX_AI_SERVICES) return null;
  return count;
}

export function tabSectionId(slug: string): string {
  return BUILTIN_TAB_SLUGS.has(slug) ? slug : `tab-${slug}`;
}
