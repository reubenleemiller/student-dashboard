ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS reschedule_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL;
