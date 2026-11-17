CREATE TABLE public.techtally_payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  amount TEXT,
  currency TEXT,
  customer_email TEXT,
  status TEXT,
  reference TEXT,
  payload JSONB NOT NULL,
  event_created_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.techtally_payment_events TO service_role;

ALTER TABLE public.techtally_payment_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX techtally_payment_events_received_idx ON public.techtally_payment_events (received_at DESC);