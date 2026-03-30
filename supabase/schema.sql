-- =============================================================
-- Student Dashboard – Supabase Schema
-- Run this entire file in the Supabase SQL Editor (or via CLI)
-- =============================================================

-- -------------------------
-- 1. profiles table
-- -------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  full_name  TEXT,
  role       TEXT NOT NULL DEFAULT 'student'
               CHECK (role IN ('student', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Students can view/update their own profile; admin can view all
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR auth.email() = 'reuben.miller@rmtutoringservices.com'
  );

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- -------------------------
-- 2. bookings table
-- -------------------------
CREATE TABLE IF NOT EXISTS public.bookings (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cal_booking_id   TEXT        UNIQUE NOT NULL,
  user_id          UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_email       TEXT        NOT NULL,
  event_type       TEXT,
  start_time       TIMESTAMPTZ NOT NULL,
  end_time         TIMESTAMPTZ NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'scheduled'
                                 CHECK (status IN ('scheduled','cancelled','rescheduled','completed')),
  join_url         TEXT,
  cancel_url       TEXT,
  reschedule_url   TEXT,
  raw_payload      JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

-- Students see only their own bookings; admin sees all
CREATE POLICY "Students see own bookings" ON public.bookings
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR auth.email() = 'reuben.miller@rmtutoringservices.com'
  );

-- Only service role (Netlify functions) can insert/update/delete bookings
CREATE POLICY "Service role manages bookings" ON public.bookings
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- -------------------------
-- 3. Auto-create profile on signup
-- -------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (
    NEW.id,
    NEW.email,
    CASE
      WHEN NEW.email = 'reuben.miller@rmtutoringservices.com' THEN 'admin'
      ELSE 'student'
    END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -------------------------
-- 4. Auto-update bookings.updated_at
-- -------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bookings_updated_at ON public.bookings;
CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -------------------------
-- 5. Storage: student-resources bucket
-- -------------------------
-- Run this in the Supabase Dashboard → Storage → "New bucket"
-- OR uncomment and run via SQL:
--
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('student-resources', 'student-resources', false)
-- ON CONFLICT (id) DO NOTHING;

-- Storage RLS policies for the student-resources bucket:
--
-- SELECT (download)
CREATE POLICY "Students download own files" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'student-resources'
    AND (
      auth.email() = 'reuben.miller@rmtutoringservices.com'
      OR name LIKE 'students/' || auth.uid()::text || '/%'
    )
  );

-- INSERT (upload)
CREATE POLICY "Students upload to own folder" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'student-resources'
    AND (
      auth.email() = 'reuben.miller@rmtutoringservices.com'
      OR name LIKE 'students/' || auth.uid()::text || '/%'
    )
  );

-- UPDATE
CREATE POLICY "Students update own files" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'student-resources'
    AND (
      auth.email() = 'reuben.miller@rmtutoringservices.com'
      OR name LIKE 'students/' || auth.uid()::text || '/%'
    )
  );

-- DELETE
CREATE POLICY "Students delete own files" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'student-resources'
    AND (
      auth.email() = 'reuben.miller@rmtutoringservices.com'
      OR name LIKE 'students/' || auth.uid()::text || '/%'
    )
  );
