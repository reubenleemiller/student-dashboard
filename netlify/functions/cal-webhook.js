// netlify/functions/cal-webhook.js
// Receives Cal.com webhook events and upserts bookings into Supabase.
// Environment variables required:
//   SUPABASE_URL              – your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service role key (not exposed to browser)
//   CAL_WEBHOOK_SECRET        – (optional) webhook secret set in Cal.com dashboard

const crypto = require('crypto');

const SUPABASE_URL            = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CAL_WEBHOOK_SECRET      = process.env.CAL_WEBHOOK_SECRET;

// Base URLs for Cal.com cancel/reschedule links (can be overridden via env var)
const CAL_CANCEL_BASE     = process.env.CAL_CANCEL_BASE_URL     || 'https://cal.com/cancellations';
const CAL_RESCHEDULE_BASE = process.env.CAL_RESCHEDULE_BASE_URL || 'https://cal.com/reschedule';

// ── helpers ──────────────────────────────────────────────────────────────────

function verifySignature(rawBody, signature, secret) {
  if (!secret) return true; // verification disabled
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody, 'utf8');
  const digest = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey':        SUPABASE_SERVICE_ROLE,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function findUserByEmail(email) {
  const rows = await supabaseFetch(
    `/profiles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0].id : null;
}

async function upsertBooking(booking) {
  await supabaseFetch('/bookings?on_conflict=cal_booking_id', {
    method:  'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(booking),
  });
}

// ── event handlers ────────────────────────────────────────────────────────────

async function handleBookingCreated(payload) {
  const attendeeEmail = (payload.attendees?.[0]?.email || '').toLowerCase();
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;

  const uid          = payload.uid;
  const joinUrl      = payload.videoCallData?.url
                    || payload.metadata?.videoCallUrl
                    || null;
  const cancelUrl     = payload.cancelUrl
                     || (uid ? `${CAL_CANCEL_BASE}/${uid}` : null);
  const rescheduleUrl = payload.rescheduleUrl
                     || (uid ? `${CAL_RESCHEDULE_BASE}/${uid}` : null);

  await upsertBooking({
    cal_booking_id:  uid,
    user_id:         userId,
    user_email:      attendeeEmail,
    event_type:      payload.type || payload.eventType?.slug || null,
    start_time:      payload.startTime,
    end_time:        payload.endTime,
    status:          'scheduled',
    join_url:        joinUrl,
    cancel_url:      cancelUrl,
    reschedule_url:  rescheduleUrl,
    raw_payload:     payload,
  });
}

async function handleBookingCancelled(payload) {
  const uid = payload.uid;
  if (!uid) return;

  // Try to fetch existing row to preserve other fields
  const rows = await supabaseFetch(
    `/bookings?cal_booking_id=eq.${encodeURIComponent(uid)}&select=id&limit=1`
  ).catch(() => []);

  if (Array.isArray(rows) && rows.length) {
    await supabaseFetch(`/bookings?cal_booking_id=eq.${encodeURIComponent(uid)}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ status: 'cancelled', raw_payload: payload }),
    });
  } else {
    // Booking not in DB yet – store it anyway
    const attendeeEmail = (payload.attendees?.[0]?.email || '').toLowerCase();
    const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;
    await upsertBooking({
      cal_booking_id: uid,
      user_id:        userId,
      user_email:     attendeeEmail,
      event_type:     payload.type || null,
      start_time:     payload.startTime,
      end_time:       payload.endTime,
      status:         'cancelled',
      raw_payload:    payload,
    });
  }
}

async function handleBookingRescheduled(payload) {
  // Cal.com gives the *new* booking a new UID; the old UID is in payload.rescheduleUid
  const newUid = payload.uid;
  const oldUid = payload.rescheduleUid || payload.metadata?.rescheduleUid;

  // Mark old booking as rescheduled
  if (oldUid) {
    await supabaseFetch(`/bookings?cal_booking_id=eq.${encodeURIComponent(oldUid)}`, {
      method:  'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body:    JSON.stringify({ status: 'rescheduled' }),
    }).catch(() => {});
  }

  // Insert/update new booking
  const attendeeEmail = (payload.attendees?.[0]?.email || '').toLowerCase();
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;
  const joinUrl       = payload.videoCallData?.url || payload.metadata?.videoCallUrl || null;
  const cancelUrl     = payload.cancelUrl     || (newUid ? `${CAL_CANCEL_BASE}/${newUid}` : null);
  const rescheduleUrl = payload.rescheduleUrl || (newUid ? `${CAL_RESCHEDULE_BASE}/${newUid}` : null);

  await upsertBooking({
    cal_booking_id: newUid,
    user_id:        userId,
    user_email:     attendeeEmail,
    event_type:     payload.type || payload.eventType?.slug || null,
    start_time:     payload.startTime,
    end_time:       payload.endTime,
    status:         'scheduled',
    join_url:       joinUrl,
    cancel_url:     cancelUrl,
    reschedule_url: rescheduleUrl,
    raw_payload:    payload,
  });
}

// ── main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawBody   = event.body || '';
  const signature = event.headers['x-cal-signature-256'] || '';

  if (!verifySignature(rawBody, signature, CAL_WEBHOOK_SECRET)) {
    console.error('Cal.com webhook signature verification failed');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const trigger = (parsed.triggerEvent || '').toUpperCase();
  const payload  = parsed.payload || parsed;

  console.log(`Cal.com webhook received: ${trigger}`);

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
