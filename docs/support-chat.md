# Support Chat – Setup Guide

The support chat widget lets students send messages to the admin/tutor directly from
`dashboard.html`. It is a floating action button (FAB) in the bottom-right corner that
opens a panel with full messaging UX: unread badge, toast notifications, typing indicator,
read receipts, and a previous-conversations history.

---

## 1. Environment Variables

Add these to your **Netlify site environment variables** (Site settings → Environment variables).

| Variable                  | Required | Description |
|---------------------------|----------|-------------|
| `SUPABASE_URL`            | ✅        | Already required – your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅      | Already required – service-role key (never expose to browser) |
| `ADMIN_EMAIL`             | optional | Email of the admin/tutor account. Used by the support inbox endpoints when present. |

No new environment variables are strictly required beyond what the rest of the site
already uses.

---

## 2. Supabase Database Objects

Run the SQL below in **Supabase → SQL Editor** (or save as a migration).

### 2a. Tables

```sql
-- Support conversations (one per student thread)
create table if not exists public.support_conversations (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  user_email      text        not null,
  resolved        boolean     not null default false,
  resolved_at     timestamptz,
  admin_typing_at timestamptz,   -- set by admin UI to show "typing" bubble to student
  user_typing_at  timestamptz,   -- set by widget when student is typing
  created_at      timestamptz not null default now()
);

-- Support messages (many per conversation)
create table if not exists public.support_messages (
  id              bigint      primary key generated always as identity,
  conversation_id uuid        not null references public.support_conversations(id) on delete cascade,
  user_id         uuid        not null references auth.users(id) on delete cascade,
  user_email      text        not null,
  body            text        not null,
  from_admin      boolean     not null default false,
  read_at         timestamptz,   -- set when the recipient reads the message
  created_at      timestamptz not null default now()
);
```

### 2b. Indexes (recommended for performance)

```sql
create index if not exists support_conversations_user_id_idx
  on public.support_conversations(user_id);

create index if not exists support_conversations_resolved_idx
  on public.support_conversations(user_id, resolved);

create index if not exists support_messages_conversation_id_idx
  on public.support_messages(conversation_id);
```

### 2c. Row-Level Security (RLS)

All reads and writes from the widget go through **Netlify Functions using the
service-role key**, which bypasses RLS entirely. You should still enable RLS on both
tables so that the anon / authenticated roles cannot access them directly from the
browser:

```sql
-- Enable RLS
alter table public.support_conversations enable row level security;
alter table public.support_messages       enable row level security;

-- No policies needed for direct client access (all access is via service-role key
-- in Netlify Functions). Add policies only if you later expose these tables to a
-- client-side Supabase query.
```

---

## 3. Admin Profile Column

The widget and admin inbox display names only. No `photo_url` column is required for
this site.

Ensure your `profiles` table has (most of these likely already exist):

| Column       | Type   | Notes |
|--------------|--------|-------|
| `id`         | uuid   | FK → `auth.users.id` |
| `role`       | text   | `'admin'` or `'student'` |
| `full_name`  | text   | Displayed as the admin name in the chat header |

If your profiles table uses different column names, update the queries in
`netlify/functions/support-messages.js`, `netlify/functions/support-inbox.js`, and
`assets/support-admin-inbox.js` accordingly.

---

## 4. Files Added / Modified

| File | Change |
|------|--------|
| `assets/support-widget.js` | **New** – front-end widget (FAB, panel, polling, theming) |
| `netlify/functions/_auth.js` | **New** – shared auth helper (token verification via Supabase + profile fetch) |
| `netlify/functions/whoami.js` | **New** – returns current user basic info |
| `netlify/functions/user-profile.js` | **New** – returns full profile row |
| `netlify/functions/ping-session.js` | **New** – session liveness check |
| `netlify/functions/support-messages.js` | **New** – GET messages / POST send message |
| `netlify/functions/support-conversations.js` | **New** – resolve / reopen / delete conversation |
| `netlify/functions/user-typing.js` | **New** – records user typing status |
| `netlify/functions/support-inbox.js` | **New** – admin inbox list, thread detail, reply, resolve/unresolve/delete |
| `netlify/functions/support-typing.js` | **New** – records admin typing status |
| `dashboard.html` | **Modified** – adds `<script src="/assets/support-widget.js">` at end of body |
| `admin.html` | **Modified** – adds support inbox section and script |
| `netlify.toml` | **Modified** – adds `/api/…` redirect rules for new functions |
| `docs/support-chat.md` | **New** – this file |

---

## 5. Theming

The widget uses the CSS custom properties already defined in `css/styles.css`:

| Widget element | CSS variable used |
|----------------|-------------------|
| FAB, send button, user messages | `--primary` |
| FAB hover, send hover | `--primary-hover` |
| Avatar background, hover highlight | `--primary-light` |
| Unread badge | `--danger` |
| Resolved banner | `--success`, `--success-light` |
| Panel background | `--surface` |
| Input border / dividers | `--border` |
| Message text | `--text` |
| Timestamps, placeholders | `--text-muted` |
| Page background (admin message bg) | `--bg` |

No values are hardcoded; changing the CSS variables in `styles.css` automatically
re-themes the widget.

---

## 6. Admin Reply Flow

The admin inbox is available in `admin.html` and uses `support-inbox` plus
`support-typing`:

- `GET /.netlify/functions/support-inbox` lists all conversations.
- `GET /.netlify/functions/support-inbox?conversation_id=<id>` loads one thread.
- `POST /.netlify/functions/support-inbox` with `action: 'reply'` sends an admin reply.
- `POST /.netlify/functions/support-inbox` with `action: 'resolve' | 'unresolve' | 'delete'`
  manages the thread state.
- `POST /.netlify/functions/support-typing` updates the admin typing indicator.

No profile photo or storage signing is required for support chat on this site.
