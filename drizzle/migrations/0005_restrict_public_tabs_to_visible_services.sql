DROP POLICY IF EXISTS "Anyone can view tabs" ON public.techtally_tabs;

CREATE POLICY "Anyone can view tabs that hold visible services"
ON public.techtally_tabs
FOR SELECT
TO anon, authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.techtally_services s
    WHERE s.category = techtally_tabs.slug
      AND s.is_visible = true
  )
);