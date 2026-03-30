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
//   CAL_USERNAME              – Cal.com username to build overlay reschedule URLs (default: rleemiller)
//
// Notes:
// - If CAL_WEBHOOK_SECRET is NOT set, signature verification is disabled.
// - Cancel URLs are stored as Cal booking management URLs on app.cal.com.
// - Reschedule URLs are stored as overlay-calendar URLs on cal.com/<username>/<eventSlug>?rescheduleUid=...

const crypto = require('crypto');

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CAL_WEBHOOK_SECRET    = process.env.CAL_WEBHOOK_SECRET;
const CAL_USERNAME          = process.env.CAL_USERNAME || 'rleemiller';

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
  return event.headers[lower] || event.headers[name] || '';
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

function extractAttendeeEmail(payload) {
  const email =
    payload?.attendees?.[0]?.email ||
    payload?.attendee?.email ||
    payload?.responses?.email ||
    '';
  return String(email || '').trim().toLowerCase();
}

function extractEventSlug(payload) {
  // You said this is likely payload.type (e.g. "90min")
  return payload?.type || payload?.eventType?.slug || null;
}

function extractJoinUrl(payload) {
  return payload?.videoCallData?.url || payload?.metadata?.videoCallUrl || null;
}

function buildCalCancelUrl(uid, attendeeEmail) {
  // Example desired shape:
  // https://app.cal.com/booking/<uid>?allRemainingBookings=false&email=...&uid=<uid>&cancel=true
  if (!uid) return null;

  const base = `https://app.cal.com/booking/${encodeURIComponent(uid)}`;
  const params = new URLSearchParams();

  params.set('allRemainingBookings', 'false');
  if (attendeeEmail) params.set('email', attendeeEmail);
  params.set('uid', uid);
  params.set('cancel', 'true');

  return `${base}?${params.toString()}`;
}

function buildCalOverlayRescheduleUrl(uid, attendeeEmail, eventSlug, startTimeIso) {
  // Example desired shape:
  // https://cal.com/<username>/<eventSlug>?rescheduleUid=<uid>&rescheduledBy=<email>&overlayCalendar=true&date=YYYY-MM-DD
  if (!CAL_USERNAME || !eventSlug || !uid) return null;

  const base = `https://cal.com/${encodeURIComponent(CAL_USERNAME)}/${encodeURIComponent(eventSlug)}`;
  const params = new URLSearchParams();

  params.set('rescheduleUid', uid);
  if (attendeeEmail) params.set('rescheduledBy', attendeeEmail);
  params.set('overlayCalendar', 'true');

  if (startTimeIso) {
    const d = new Date(startTimeIso);
    if (!Number.isNaN(d.getTime())) {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      params.set('date', `${yyyy}-${mm}-${dd}`);
    }
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
  const rows = await supabaseFetch(`/profiles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
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

async function handleBookingCreated(payload) {
  const attendeeEmail = extractAttendeeEmail(payload);
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;

  const uid = payload.uid;
  const eventSlug = extractEventSlug(payload);

  const cancelUrl =
    payload.cancelUrl ||
    payload.metadata?.cancelUrl ||
    buildCalCancelUrl(uid, attendeeEmail);

  const rescheduleUrl =
    payload.rescheduleUrl ||
    payload.metadata?.rescheduleUrl ||
    buildCalOverlayRescheduleUrl(uid, attendeeEmail, eventSlug, payload.startTime);

  await upsertBooking({
    cal_booking_id: uid,
    user_id: userId,
    user_email: attendeeEmail,
    event_type: eventSlug,
    start_time: payload.startTime,
    end_time: payload.endTime,
    status: 'scheduled',
    join_url: extractJoinUrl(payload),
    cancel_url: cancelUrl,
    reschedule_url: rescheduleUrl,
    raw_payload: payload,
  });
}

async function handleBookingCancelled(payload) {
  const uid = payload.uid;
  if (!uid) return;

  // Update status if it exists
  const rows = await supabaseFetch(
    `/bookings?cal_booking_id=eq.${encodeURIComponent(uid)}&select=id, user_email, event_type, start_time&limit=1`
  ).catch(() => []);

  if (Array.isArray(rows) && rows.length) {
    const existing = rows[0];

    // Keep/repair cancel/reschedule URLs on cancel event too
    const attendeeEmail = (existing.user_email || extractAttendeeEmail(payload) || '').toLowerCase();
    const eventSlug = existing.event_type || extractEventSlug(payload);
    const startTime = existing.start_time || payload.startTime || null;

    const cancelUrl =
      payload.cancelUrl ||
      payload.metadata?.cancelUrl ||
      buildCalCancelUrl(uid, attendeeEmail);

    // For cancelled bookings we still store it (for history), but UI should hide reschedule.
    const rescheduleUrl =
      payload.rescheduleUrl ||
      payload.metadata?.rescheduleUrl ||
      buildCalOverlayRescheduleUrl(uid, attendeeEmail, eventSlug, startTime);

    await supabaseFetch(`/bookings?cal_booking_id=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'cancelled',
        cancel_url: cancelUrl,
        reschedule_url: rescheduleUrl,
        raw_payload: payload,
      }),
    });
    return;
  }

  // If booking not found, store a minimal cancelled booking
  const attendeeEmail = extractAttendeeEmail(payload);
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;
  const eventSlug = extractEventSlug(payload);

  await upsertBooking({
    cal_booking_id: uid,
    user_id: userId,
    user_email: attendeeEmail,
    event_type: eventSlug,
    start_time: payload.startTime,
    end_time: payload.endTime,
    status: 'cancelled',
    join_url: extractJoinUrl(payload),
    cancel_url:
      payload.cancelUrl ||
      payload.metadata?.cancelUrl ||
      buildCalCancelUrl(uid, attendeeEmail),
    reschedule_url:
      payload.rescheduleUrl ||
      payload.metadata?.rescheduleUrl ||
      buildCalOverlayRescheduleUrl(uid, attendeeEmail, eventSlug, payload.startTime),
    raw_payload: payload,
  });
}

async function handleBookingRescheduled(payload) {
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

  // Upsert the new booking as scheduled
  const attendeeEmail = extractAttendeeEmail(payload);
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;
  const eventSlug = extractEventSlug(payload);

  const cancelUrl =
    payload.cancelUrl ||
    payload.metadata?.cancelUrl ||
    buildCalCancelUrl(newUid, attendeeEmail);

  const rescheduleUrl =
    payload.rescheduleUrl ||
    payload.metadata?.rescheduleUrl ||
    buildCalOverlayRescheduleUrl(newUid, attendeeEmail, eventSlug, payload.startTime);

  await upsertBooking({
    cal_booking_id: newUid,
    user_id: userId,
    user_email: attendeeEmail,
    event_type: eventSlug,
    start_time: payload.startTime,
    end_time: payload.endTime,
    status: 'scheduled',
    join_url: extractJoinUrl(payload),
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
