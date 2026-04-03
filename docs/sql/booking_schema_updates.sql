-- docs/sql/booking_schema_updates.sql
-- Run these migrations in your Supabase SQL editor (or via the CLI).
-- All statements are idempotent (IF NOT EXISTS / IF EXISTS guards).

-- 1) Track how many times a booking has been rescheduled.
--    Incremented on BOOKING_RESCHEDULED events; the old row is deleted and the
--    new booking row carries the accumulated count.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS reschedule_count integer NOT NULL DEFAULT 0;

-- 2) Timestamp set when a MEETING_ENDED webhook is received (status = 'completed').
--    The UI also falls back to end_time < now() when this column is NULL.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL;

-- 3) Allow students to hide a booking from their dashboard view.
--    Queries in the student UI filter WHERE archived_by_user = false.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS archived_by_user boolean NOT NULL DEFAULT false;

-- 4) Extended status values supported by the application:
--    'scheduled'  – active / upcoming booking (default)
--    'cancelled'  – BOOKING_CANCELLED received
--    'rescheduled'– legacy; new bookings carry reschedule_count instead
--    'completed'  – MEETING_ENDED received (or end_time < now() as fallback)
--    'requested'  – BOOKING_REQUESTED received (pending organiser confirmation)
--    'rejected'   – BOOKING_REJECTED received (organiser declined)
--
-- If your status column already has a CHECK constraint, extend it:
-- ALTER TABLE public.bookings
--   DROP CONSTRAINT IF EXISTS bookings_status_check;
-- ALTER TABLE public.bookings
--   ADD CONSTRAINT bookings_status_check
--     CHECK (status IN ('scheduled','cancelled','rescheduled','completed','requested','rejected'));
