// netlify/functions/cal-webhook.js
// Receives Cal.com webhook events and upserts bookings into Supabase.
//
// Environment variables required:
//   SUPABASE_URL              – your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service role key (not exposed to browser)
//
// Optional environment variables:
//   CAL_WEBHOOK_SECRET        – if set, will accept either:
//                                (A) HMAC signature header (x-cal-signature-256 / x-cal-signature)
//                                    where signature is "sha256=<hex>" OR "<hex>"
//                                (B) shared secret header (x-webhook-secret) equal to CAL_WEBHOOK_SECRET
//
// Notes:
// - If CAL_WEBHOOK_SECRET is NOT set, signature verification is disabled.
// - Cancel/reschedule URLs are normalized to https://app.cal.com/booking/<uid>?... format.

const crypto = require('crypto');

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CAL_WEBHOOK_SECRET    = process.env.CAL_WEBHOOK_SECRET;

if (!SUPABASE_URL) throw new Error('SUPABASE_URL environment variable is required');
if (!SUPABASE_SERVICE_ROLE) throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');

// ── helpers ──────────────────────────────────────────────────────────────────

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getHeader(event, name) {
  if (!event?.headers) return '';
  const lower = name.toLowerCase();

  // Netlify normalizes to lowercase, but be safe:
  return (
    event.headers[lower] ||
    event.headers[name] ||
    ''
  );
}

function normalizeCalSignature(sig) {
  if (!sig) return '';
  const s = String(sig).trim();
  if (!s) return '';
  return s.startsWith('sha256=') ? s.slice('sha256='.length) : s;
}

function computeHmacHex(rawBody, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody, 'utf8');
  return hmac.digest('hex');
}

function verifyCalWebhook(event) {
  // If no secret configured, verification is disabled
  if (!CAL_WEBHOOK_SECRET) return { ok: true, mode: 'disabled' };

  const rawBody = event.body || '';

  // 1) Try HMAC signature headers
  const sigHeader =
    getHeader(event, 'x-cal-signature-256') ||
    getHeader(event, 'x-cal-signature');

  if (sigHeader) {
    const providedHex = normalizeCalSignature(sigHeader);
    const expectedHex = computeHmacHex(rawBody, CAL_WEBHOOK_SECRET);

    // constant-time compare when lengths match
    const ok = providedHex.length === expectedHex.length && safeEqual(providedHex, expectedHex);
    return { ok, mode: 'hmac', hasSignature: true };
  }

  // 2) Fallback: shared secret header (useful if Cal.com is not sending HMAC header)
  const shared = getHeader(event, 'x-webhook-secret');
  if (shared) {
    const ok = safeEqual(String(shared).trim(), String(CAL_WEBHOOK_SECRET).trim());
    return { ok, mode: 'shared-secret', hasSharedSecret: true };
  }

  return { ok: false, mode: 'missing-auth', hasSignature: false, hasSharedSecret: false };
}

function buildCalManageUrl(uid, attendeeEmail, mode) {
  // mode: 'cancel' | 'reschedule'
  if (!uid) return null;

  const base = `https://app.cal.com/booking/${encodeURIComponent(uid)}`;
  const params = new URLSearchParams();

  params.set('allRemainingBookings', 'false');
  params.set('uid', uid);

  if (attendeeEmail) params.set('email', attendeeEmail);

  if (mode === 'cancel') {
    params.set('cancel', 'true');
  } else if (mode === 'reschedule') {
    params.set('reschedule', 'true');
  }

  return `${base}?${params.toString()}`;
}

async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function findUserByEmail(email) {
  if (!email) return null;
  const rows = await supabaseFetch(
    `/profiles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0].id : null;
}

async function upsertBooking(booking) {
  await supabaseFetch('/bookings?on_conflict=cal_booking_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(booking),
  });
}

// ── event handlers ───────────────────────────────────────────────────────────

function extractAttendeeEmail(payload) {
  // Prefer first attendee email (most common Cal payload)
  const email =
    payload?.attendees?.[0]?.email ||
    payload?.attendee?.email ||
    payload?.responses?.email ||
    '';

  return String(email || '').trim().toLowerCase();
}

function extractEventType(payload) {
  return payload?.type || payload?.eventType?.slug || payload?.eventType || null;
}

async function handleBookingCreated(payload) {
  const attendeeEmail = extractAttendeeEmail(payload);
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;

  const uid = payload.uid;

  const joinUrl =
    payload.videoCallData?.url ||
    payload.metadata?.videoCallUrl ||
    null;

  const cancelUrl =
    payload.cancelUrl ||
    payload.metadata?.cancelUrl ||
    buildCalManageUrl(uid, attendeeEmail, 'cancel');

  const rescheduleUrl =
    payload.rescheduleUrl ||
    payload.metadata?.rescheduleUrl ||
    buildCalManageUrl(uid, attendeeEmail, 'reschedule');

  await upsertBooking({
    cal_booking_id: uid,
    user_id: userId,
    user_email: attendeeEmail,
    event_type: extractEventType(payload),
    start_time: payload.startTime,
    end_time: payload.endTime,
    status: 'scheduled',
    join_url: joinUrl,
    cancel_url: cancelUrl,
    reschedule_url: rescheduleUrl,
    raw_payload: payload,
  });
}

async function handleBookingCancelled(payload) {
  const uid = payload.uid;
  if (!uid) return;

  // Patch existing booking if it exists; otherwise store it as cancelled
  const rows = await supabaseFetch(
    `/bookings?cal_booking_id=eq.${encodeURIComponent(uid)}&select=id&limit=1`
  ).catch(() => []);

  if (Array.isArray(rows) && rows.length) {
    await supabaseFetch(`/bookings?cal_booking_id=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'cancelled', raw_payload: payload }),
    });
    return;
  }

  const attendeeEmail = extractAttendeeEmail(payload);
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;

  await upsertBooking({
    cal_booking_id: uid,
    user_id: userId,
    user_email: attendeeEmail,
    event_type: extractEventType(payload),
    start_time: payload.startTime,
    end_time: payload.endTime,
    status: 'cancelled',
    join_url: payload.videoCallData?.url || payload.metadata?.videoCallUrl || null,
    cancel_url:
      payload.cancelUrl ||
      payload.metadata?.cancelUrl ||
      buildCalManageUrl(uid, attendeeEmail, 'cancel'),
    reschedule_url:
      payload.rescheduleUrl ||
      payload.metadata?.rescheduleUrl ||
      buildCalManageUrl(uid, attendeeEmail, 'reschedule'),
    raw_payload: payload,
  });
}

async function handleBookingRescheduled(payload) {
  // Cal.com gives the new booking a new UID; old UID sometimes in rescheduleUid
  const newUid = payload.uid;
  const oldUid = payload.rescheduleUid || payload.metadata?.rescheduleUid;

  // Mark old booking as rescheduled (best effort)
  if (oldUid) {
    await supabaseFetch(`/bookings?cal_booking_id=eq.${encodeURIComponent(oldUid)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'rescheduled' }),
    }).catch(() => {});
  }

  const attendeeEmail = extractAttendeeEmail(payload);
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;

  const joinUrl =
    payload.videoCallData?.url ||
    payload.metadata?.videoCallUrl ||
    null;

  const cancelUrl =
    payload.cancelUrl ||
    payload.metadata?.cancelUrl ||
    buildCalManageUrl(newUid, attendeeEmail, 'cancel');

  const rescheduleUrl =
    payload.rescheduleUrl ||
    payload.metadata?.rescheduleUrl ||
    buildCalManageUrl(newUid, attendeeEmail, 'reschedule');

  await upsertBooking({
    cal_booking_id: newUid,
    user_id: userId,
    user_email: attendeeEmail,
    event_type: extractEventType(payload),
    start_time: payload.startTime,
    end_time: payload.endTime,
    status: 'scheduled',
    join_url: joinUrl,
    cancel_url: cancelUrl,
    reschedule_url: rescheduleUrl,
    raw_payload: payload,
  });
}

// ── main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const verification = verifyCalWebhook(event);
  if (!verification.ok) {
    // Do not log secrets; just log what auth material was present.
    const headerKeys = Object.keys(event.headers || {}).sort();
    console.error('Cal.com webhook verification failed', {
      mode: verification.mode,
      hasSignature: !!verification.hasSignature,
      hasSharedSecret: !!verification.hasSharedSecret,
      headerKeys,
    });
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const rawBody = event.body || '';

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const trigger = String(parsed.triggerEvent || '').toUpperCase();
  const payload = parsed.payload || parsed;

  console.log(`Cal.com webhook received: ${trigger} (auth=${verification.mode})`);

  try {
    if (trigger === 'BOOKING_CREATED') {
      await handleBookingCreated(payload);
    } else if (trigger === 'BOOKING_CANCELLED') {
      await handleBookingCancelled(payload);
    } else if (trigger === 'BOOKING_RESCHEDULED') {
      await handleBookingRescheduled(payload);
    } else {
      console.log(`Unhandled trigger: ${trigger}`);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('cal-webhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};