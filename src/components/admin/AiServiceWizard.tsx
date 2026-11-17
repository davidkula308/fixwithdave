import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, ImageUp, Loader2, Sparkles, Trash2, Wand2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Tables } from "@/integrations/supabase/types";
import { BUILTIN_TABS, MAX_AI_SERVICES, cleanTabLabel, slugifyTabLabel, type AiIdeaSource, type AiTheme } from "@/lib/service-categories";
import { compressCardImage, streamImage } from "@/lib/stream-image";

type ServiceRow = Tables<"techtally_services">;
export type CustomTab = { slug: string; label: string };

type Step = "setup" | "idea" | "mode" | "review" | "auto";
type Mode = "manual" | "auto";
type DraftStatus = "draft" | "imaging" | "saving" | "saved" | "error";
type Draft = {
  key: string;
  title: string;
  description: string;
  imagePrompt: string;
  image: string;
  imageFinal: boolean;
  status: DraftStatus;
  error: string;
};

const NEW_TAB = "__new__";

function OptionCard({ selected, onClick, title, description }: { selected: boolean; onClick: () => void; title: string; description?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-lg border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"}`}
    >
      <span className="flex items-center justify-between gap-2 text-sm font-semibold">
        {title}
        {selected && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
      </span>
      {description && <span className="mt-1 block text-xs text-muted-foreground">{description}</span>}
    </button>
  );
}

async function postAdmin<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let result: unknown = null;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Something went wrong. Please try again.");
  }
  if (!response.ok) {
    const message = result && typeof result === "object" && "error" in result ? String((result as { error: unknown }).error) : "Something went wrong.";
    throw new Error(message);
  }
  return result as T;
}

export function AiServiceWizard({
  tabs,
  onServicesChanged,
  onClose,
}: {
  tabs: CustomTab[];
  onServicesChanged: (services: ServiceRow[]) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("setup");
  const [count, setCount] = useState(2);
  const [tabChoice, setTabChoice] = useState<string>("services");
  const [newTabLabel, setNewTabLabel] = useState("");
  const [ideaSource, setIdeaSource] = useState<AiIdeaSource>("random");
  const [idea, setIdea] = useState("");
  const [theme, setTheme] = useState<AiTheme>("general");
  const [mode, setMode] = useState<Mode>("manual");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isNewTab = tabChoice === NEW_TAB;
  const category = isNewTab ? slugifyTabLabel(newTabLabel) : tabChoice;
  const tabLabel = isNewTab ? cleanTabLabel(newTabLabel) : null;
  const destinationName = isNewTab
    ? newTabLabel.trim()
    : [...BUILTIN_TABS, ...tabs].find((tab) => tab.slug === tabChoice)?.label ?? "Services";

  const updateDraft = (key: string, patch: Partial<Draft>) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));

  const goToIdea = () => {
    if (isNewTab && !tabLabel) {
      setError("Give the new tab a name (2–40 letters) that isn't Services, Gaming or Storage Fix.");
      return;
    }
    setError("");
    setTheme(tabChoice === "gaming" ? "gaming" : tabChoice === "storage-fix" ? "storage-fix" : "general");
    setStep("idea");
  };

  const goToMode = () => {
    if (ideaSource === "described" && !idea.trim()) {
      setError("Describe the services you want, or choose random ideas.");
      return;
    }
    setError("");
    setStep("mode");
  };

  const makeImage = async (draft: Pick<Draft, "key" | "title" | "imagePrompt">): Promise<string> => {
    updateDraft(draft.key, { status: "imaging", error: "", imageFinal: false });
    let finalImage = "";
    await streamImage("/api/admin", { action: "ai-image", title: draft.title, image_prompt: draft.imagePrompt }, (dataUrl, isFinal) => {
      updateDraft(draft.key, { image: dataUrl, imageFinal: isFinal });
      if (isFinal) finalImage = dataUrl;
    });
    const compressed = await compressCardImage(finalImage);
    updateDraft(draft.key, { image: compressed, imageFinal: true, status: "draft" });
    return compressed;
  };

  const saveDraft = async (draft: Pick<Draft, "key" | "title" | "description">, image: string) => {
    updateDraft(draft.key, { status: "saving", error: "" });
    const services = await postAdmin<ServiceRow[]>({
      action: "save-service",
      title: draft.title,
      description: draft.description,
      image_data: image,
      image_alt: draft.title,
      show_price: false,
      price_usd: "",
      category,
      tab_label: tabLabel ?? undefined,
    });
    updateDraft(draft.key, { status: "saved" });
    onServicesChanged(services);
  };

  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await postAdmin<{ drafts: { title: string; description: string; image_prompt: string }[] }>({
        action: "ai-draft-services",
        count,
        category,
        tab_label: tabLabel ?? undefined,
        theme,
        idea_source: ideaSource,
        idea,
      });
      const nextDrafts: Draft[] = result.drafts.map((draft, index) => ({
        key: `${Date.now()}-${index}`,
        title: draft.title,
        description: draft.description,
        imagePrompt: draft.image_prompt,
        image: "",
        imageFinal: false,
        status: "draft",
        error: "",
      }));
      setDrafts(nextDrafts);
      if (mode === "manual") {
        setStep("review");
        return;
      }
      setStep("auto");
      for (const draft of nextDrafts) {
        try {
          const image = await makeImage(draft);
          await saveDraft(draft, image);
        } catch (itemError) {
          updateDraft(draft.key, { status: "error", error: itemError instanceof Error ? itemError.message : "Could not finish this service." });
        }
      }
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "The AI could not write services right now.");
    } finally {
      setBusy(false);
    }
  };

  const handleManualImage = async (draft: Draft) => {
    if (!draft.title.trim()) {
      updateDraft(draft.key, { error: "Add a title before making an image." });
      return;
    }
    try {
      await makeImage(draft);
    } catch (imageError) {
      updateDraft(draft.key, { status: "error", error: imageError instanceof Error ? imageError.message : "The image could not be made." });
    }
  };

  const handleUpload = (draft: Draft, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type) || file.size > 4 * 1024 * 1024) {
      updateDraft(draft.key, { error: "Choose a JPG, PNG, or WebP image up to 4 MB." });
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result !== "string") return;
      try {
        updateDraft(draft.key, { image: await compressCardImage(reader.result), imageFinal: true, error: "", status: "draft" });
      } catch {
        updateDraft(draft.key, { error: "That image could not be opened." });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleManualSave = async (draft: Draft) => {
    if (!draft.title.trim() || !draft.description.trim()) {
      updateDraft(draft.key, { error: "Add a title and description." });
      return;
    }
    if (!draft.image || !draft.imageFinal) {
      updateDraft(draft.key, { error: "Make or upload an image before saving." });
      return;
    }
    try {
      await saveDraft(draft, draft.image);
    } catch (saveError) {
      updateDraft(draft.key, { status: "error", error: saveError instanceof Error ? saveError.message : "Could not save this service." });
    }
  };

  const tabOptions = [...BUILTIN_TABS, ...tabs];
  const working = (draft: Draft) => draft.status === "imaging" || draft.status === "saving";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> Add with AI</h3>
          <p className="text-xs text-muted-foreground">
            {step === "setup" && "Step 1 of 3 · How many services, and where should they go?"}
            {step === "idea" && "Step 2 of 3 · What kind of services?"}
            {step === "mode" && "Step 3 of 3 · Review first, or let AI do everything?"}
            {step === "review" && `Check each service, make an image, then save it to ${destinationName}.`}
            {step === "auto" && `AI is writing, making images and saving to ${destinationName}.`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close Add with AI" disabled={busy}><X /></Button>
      </div>

      {step === "setup" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Number of services</Label>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: MAX_AI_SERVICES }, (_, index) => index + 1).map((value) => (
                <Button key={value} type="button" size="sm" variant={count === value ? "default" : "outline"} onClick={() => setCount(value)} aria-pressed={count === value} className="w-10">{value}</Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Add them under</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {tabOptions.map((tab) => (
                <OptionCard key={tab.slug} selected={tabChoice === tab.slug} onClick={() => setTabChoice(tab.slug)} title={tab.label} />
              ))}
              <OptionCard selected={isNewTab} onClick={() => setTabChoice(NEW_TAB)} title="+ A new tab" description="Creates a new section in the top menu." />
            </div>
            {isNewTab && (
              <div className="space-y-1 pt-1">
                <Label htmlFor="ai-new-tab">New tab name</Label>
                <Input id="ai-new-tab" maxLength={40} placeholder="e.g. Phone Repairs" value={newTabLabel} onChange={(event) => setNewTabLabel(event.target.value)} />
              </div>
            )}
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end"><Button type="button" onClick={goToIdea}>Next <ArrowRight /></Button></div>
        </div>
      )}

      {step === "idea" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Ideas</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <OptionCard selected={ideaSource === "random"} onClick={() => setIdeaSource("random")} title="Random new services" description="AI suggests services you don't offer yet." />
              <OptionCard selected={ideaSource === "described"} onClick={() => setIdeaSource("described")} title="I'll describe them" description="Tell AI what you have in mind." />
            </div>
            {ideaSource === "described" && (
              <Textarea aria-label="Describe the services" maxLength={600} rows={3} placeholder="e.g. Laptop screen and keyboard replacement" value={idea} onChange={(event) => setIdea(event.target.value)} />
            )}
          </div>
          <div className="space-y-2">
            <Label>Type of service</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              <OptionCard selected={theme === "gaming"} onClick={() => setTheme("gaming")} title="Gaming" />
              <OptionCard selected={theme === "storage-fix"} onClick={() => setTheme("storage-fix")} title="Storage Fix" />
              <OptionCard selected={theme === "general"} onClick={() => setTheme("general")} title="General" description="A random mix" />
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => { setError(""); setStep("setup"); }}><ArrowLeft /> Back</Button>
            <Button type="button" onClick={goToMode}>Next <ArrowRight /></Button>
          </div>
        </div>
      )}

      {step === "mode" && (
        <div className="space-y-4">
          <div className="grid gap-2">
            <OptionCard selected={mode === "manual"} onClick={() => setMode("manual")} title="Let me review first" description="AI writes the titles and descriptions. You edit them, make an image, and nothing goes on the site until you click Save." />
            <OptionCard selected={mode === "auto"} onClick={() => setMode("auto")} title="Fully automatic" description="AI writes the title, description and image, then adds each service to the site straight away." />
          </div>
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {count} service{count > 1 ? "s" : ""} · {destinationName}{isNewTab ? " (new tab)" : ""} · {ideaSource === "random" ? "random ideas" : "your description"} · {theme === "storage-fix" ? "Storage Fix" : theme === "gaming" ? "Gaming" : "General"}. Price tags stay off; you can add one later with Edit.
          </p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => { setError(""); setStep("idea"); }} disabled={busy}><ArrowLeft /> Back</Button>
            <Button type="button" onClick={() => void generate()} disabled={busy}>
              {busy ? <><Loader2 className="animate-spin" /> AI is writing…</> : <><Wand2 /> Generate</>}
            </Button>
          </div>
        </div>
      )}

      {(step === "review" || step === "auto") && (
        <div className="space-y-3">
          {drafts.map((draft, index) => (
            <article key={draft.key} className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted-foreground">Service {index + 1}</span>
                <span className={`text-xs font-semibold ${draft.status === "saved" ? "text-primary" : draft.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                  {draft.status === "imaging" && "Making image…"}
                  {draft.status === "saving" && "Saving…"}
                  {draft.status === "saved" && "Saved to site ✓"}
                  {draft.status === "error" && "Needs attention"}
                  {draft.status === "draft" && (step === "auto" ? "Waiting…" : draft.image ? "Ready to save" : "Not saved yet")}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <div className="relative aspect-[3/2] overflow-hidden rounded-md bg-muted">
                  {draft.image ? (
                    <img src={draft.image} alt={`Card image for ${draft.title}`} className={`h-full w-full object-cover transition-[filter] duration-500 ${draft.imageFinal ? "blur-0" : "blur-2xl"}`} />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No image yet</div>
                  )}
                  {draft.status === "imaging" && <Loader2 className="absolute right-2 top-2 h-4 w-4 animate-spin text-primary-foreground" aria-hidden="true" />}
                </div>
                {step === "review" && draft.status !== "saved" ? (
                  <div className="space-y-2">
                    <Input aria-label={`Title for service ${index + 1}`} maxLength={100} value={draft.title} onChange={(event) => updateDraft(draft.key, { title: event.target.value })} disabled={working(draft)} />
                    <Textarea aria-label={`Description for service ${index + 1}`} maxLength={2000} rows={4} value={draft.description} onChange={(event) => updateDraft(draft.key, { description: event.target.value })} disabled={working(draft)} />
                  </div>
                ) : (
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold">{draft.title}</h4>
                    <p className="whitespace-pre-line text-xs text-muted-foreground">{draft.description}</p>
                  </div>
                )}
              </div>
              {draft.error && <p role="alert" className="text-xs text-destructive">{draft.error}</p>}
              {step === "review" && draft.status !== "saved" && (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts((current) => current.filter((item) => item.key !== draft.key))} disabled={working(draft)}><Trash2 /> Remove</Button>
                  <Button type="button" variant="outline" size="sm" asChild>
                    <label className={working(draft) ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                      <ImageUp /> Upload
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => handleUpload(draft, event)} />
                    </label>
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleManualImage(draft)} disabled={working(draft)}>
                    {draft.status === "imaging" ? <Loader2 className="animate-spin" /> : <Sparkles />} {draft.image ? "New AI image" : "Generate image"}
                  </Button>
                  <Button type="button" size="sm" onClick={() => void handleManualSave(draft)} disabled={working(draft)}>
                    {draft.status === "saving" ? <Loader2 className="animate-spin" /> : <Check />} Save
                  </Button>
                </div>
              )}
              {step === "auto" && draft.status === "error" && (
                <div className="flex justify-end">
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void (async () => {
                    try {
                      const image = draft.image && draft.imageFinal ? draft.image : await makeImage(draft);
                      await saveDraft(draft, image);
                    } catch (retryError) {
                      updateDraft(draft.key, { status: "error", error: retryError instanceof Error ? retryError.message : "Could not finish this service." });
                    }
                  })()}>Try again</Button>
                </div>
              )}
            </article>
          ))}
          {drafts.length === 0 && <p className="text-sm text-muted-foreground">No services left to review.</p>}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => { setDrafts([]); setStep("setup"); }} disabled={busy || drafts.some(working)}><Sparkles /> Start over</Button>
            <Button type="button" onClick={onClose} disabled={busy || drafts.some(working)}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}
