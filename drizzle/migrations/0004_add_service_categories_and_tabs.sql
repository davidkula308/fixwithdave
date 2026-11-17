ALTER TABLE public.techtally_services ADD COLUMN category TEXT NOT NULL DEFAULT 'services';

CREATE TABLE public.techtally_tabs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.techtally_tabs TO anon, authenticated;
GRANT ALL ON public.techtally_tabs TO service_role;

ALTER TABLE public.techtally_tabs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view tabs" ON public.techtally_tabs FOR SELECT TO anon, authenticated USING (true);