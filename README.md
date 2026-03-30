# RM Tutoring – Student Dashboard

A deployable student portal built with **HTML / CSS / vanilla JS**, backed by **Supabase** (Auth, Postgres, Storage) and **Netlify** (static hosting + serverless functions), integrated with **Cal.com Cloud** for booking management.

---

## Feature overview

| Feature | Details |
|---|---|
| Authentication | Email/password sign-up, sign-in, forgot-password, change-password, delete account |
| Student bookings | View upcoming/past bookings (list + month calendar); join, cancel, reschedule links |
| Book a session | Embedded Cal.com booking widgets (60 / 90 / 120 min) with email pre-fill |
| Resources | Per-student private file storage (upload, download, create folders, delete) |
| Admin dashboard | View all students, all bookings (with links), browse & manage any student's storage |
| Webhook sync | Netlify Function receives Cal.com events → upserts bookings into Supabase |

---

## Project structure

```
/
├── index.html                  Landing page
├── login.html                  Sign in
├── signup.html                 Create account
├── reset-password.html         Forgot / reset password
├── dashboard.html              Student dashboard
├── admin.html                  Admin (instructor) dashboard
├── css/
│   └── styles.css              All shared styles
├── js/
│   ├── supabase-client.js      Supabase client singleton (set your keys here)
│   ├── auth.js                 Auth guards + shared utilities
│   └── calendar.js             Pure-JS month calendar component
├── netlify/
│   └── functions/
│       ├── cal-webhook.js      Cal.com webhook receiver
│       └── delete-account.js   Secure account-deletion endpoint
├── supabase/
│   └── schema.sql              All tables, triggers, and RLS policies
└── netlify.toml                Netlify build & functions configuration
```

---

## Setup guide

### 1 · Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project.
2. In **Settings → API** note down:
   - **Project URL** (`SUPABASE_URL`)
   - **anon / public key** (`SUPABASE_ANON_KEY`)
   - **service_role key** (`SUPABASE_SERVICE_ROLE_KEY`) — keep this secret

### 2 · Run the database schema

1. Open the **SQL Editor** in your Supabase dashboard.
2. Paste the entire contents of `supabase/schema.sql` and run it.
3. In **Storage → Buckets**, create a new bucket named exactly **`student-resources`** and set it to **Private** (not public). The RLS policies are applied by the schema SQL.

### 3 · Configure the frontend Supabase keys

Open `js/supabase-client.js` and replace the two placeholder values:

```js
const SUPABASE_URL      = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key-here';
```

These are **public** values — they are safe to commit and expose in browser code.

### 4 · Deploy to Netlify

#### Via Netlify UI

1. Push this repo to GitHub (already done).
2. Log in to [netlify.com](https://netlify.com) and click **Add new site → Import an existing project**.
3. Choose the **rebeccalynnmiller/student-dashboard** repo.
4. Build settings are read automatically from `netlify.toml`:
   - **Publish directory**: `.`
   - **Functions directory**: `netlify/functions`
5. Add the following **environment variables** under *Site settings → Environment variables*:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | your Supabase service-role key |
| `CAL_WEBHOOK_SECRET` | the secret you set in Cal.com (optional but recommended) |

6. Deploy the site.

#### Via Netlify CLI (local)

```bash
npm install -g netlify-cli
netlify login
netlify init        # link to existing site or create new
netlify dev         # run locally with functions at http://localhost:8888
```

### 5 · Configure the Cal.com webhook

1. Log in to [cal.com](https://cal.com) and go to **Settings → Developer → Webhooks → Add webhook**.
2. Set the **Subscriber URL** to your deployed Netlify URL:
   ```
   https://your-site.netlify.app/api/cal-webhook
   ```
3. Enable the following triggers:
   - `BOOKING_CREATED`
   - `BOOKING_CANCELLED`
   - `BOOKING_RESCHEDULED`
4. (Recommended) Add a **Secret** and set the same value as `CAL_WEBHOOK_SECRET` in your Netlify env vars.

### 6 · Create the admin account

1. Sign up at `/signup.html` using the email `reuben.miller@rmtutoringservices.com`.
2. The database trigger automatically assigns the `admin` role to this email.
3. After email confirmation, log in — you will be redirected to `/admin.html`.

---

## Running locally

```bash
# Install Netlify CLI if you haven't already
npm install -g netlify-cli

# Set environment variables in a .env file (never commit this file)
echo 'SUPABASE_URL=https://your-project.supabase.co'       >> .env
echo 'SUPABASE_SERVICE_ROLE_KEY=your-service-role-key'     >> .env
echo 'CAL_WEBHOOK_SECRET=your-webhook-secret'              >> .env

# Start local dev server with Functions support
netlify dev
```

The app will be available at `http://localhost:8888`.
Netlify Functions will be served at `http://localhost:8888/.netlify/functions/*`.

To test webhooks locally you can use [ngrok](https://ngrok.com):

```bash
ngrok http 8888
# then set the ngrok URL as your Cal.com webhook subscriber URL temporarily
```

---

## Environment variables reference

| Variable | Where used | Description |
|---|---|---|
| `SUPABASE_URL` | Functions + frontend | Supabase project URL |
| `SUPABASE_ANON_KEY` | Frontend (`js/supabase-client.js`) | Public anon key — safe in browser |
| `SUPABASE_SERVICE_ROLE_KEY` | Netlify Functions only | Admin key — never expose to browser |
| `CAL_WEBHOOK_SECRET` | `netlify/functions/cal-webhook.js` | HMAC secret to verify Cal.com payloads |

---

## Supabase RLS policy summary

### `profiles` table
- Authenticated users can **SELECT** their own row.
- The admin email (`reuben.miller@rmtutoringservices.com`) can SELECT all rows.
- Users can UPDATE only their own row.

### `bookings` table
- Authenticated users can **SELECT** rows where `user_id = auth.uid()`.
- The admin email can SELECT all rows.
- Only the **service role** (Netlify Functions) can INSERT / UPDATE / DELETE.

### `storage.objects` (bucket: `student-resources`)
- Students can SELECT / INSERT / UPDATE / DELETE only under `students/<their-uid>/`.
- The admin email can access all paths.

---

## Cal.com booking sync flow

```
Student books on Cal.com embed
        ↓
Cal.com fires webhook → POST /api/cal-webhook (Netlify Function)
        ↓
Function verifies HMAC signature (if CAL_WEBHOOK_SECRET set)
        ↓
Extracts attendee email, looks up matching Supabase profile
        ↓
Upserts booking row in `bookings` table
(user_id may be null if email not found — visible to admin)
        ↓
Student sees booking in dashboard (queried from Supabase)
```

---

## Notes

- **No Cal.com API key is required** for the student-facing features — bookings are synced one-way via webhooks.
- Cancel and reschedule actions redirect to Cal.com's native cancel/reschedule pages.
- The Cal.com embed pre-fills the student's registered email to ensure booking-to-account matching.
