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
  const calStatus = String(payload?.status || '').toUpperCase();

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

  // Recurring acceptance propagation: mark sibling occurrences as scheduled too
  if (calStatus === 'ACCEPTED' && payload.recurringEvent && payload.bookingId) {
    await propagateRecurringAccepted(payload, userId, attendeeEmail, uid);
  }
}

async function handleBookingCancelled(payload) {
  const uid = payload.uid;
  if (!uid) return;

  // Update status if it exists
  const rows = await supabaseFetch(
    `/bookings?cal_booking_id=eq.${encodeURIComponent(uid)}&select=id,user_id,user_email,event_type,start_time&limit=1`
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

    // Recurring cancellation propagation: mark sibling occurrences as cancelled too
    if (payload.recurringEvent && payload.bookingId) {
      const existingUserId = existing.user_id || null;
      await propagateRecurringCancellation(payload, existingUserId, attendeeEmail, uid);
    }
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

  // Recurring cancellation propagation: mark sibling occurrences as cancelled too
  if (payload.recurringEvent && payload.bookingId) {
    await propagateRecurringCancellation(payload, userId, attendeeEmail, uid);
  }
}

async function handleBookingRescheduled(payload) {
  const newUid = payload.uid;
  const oldUid = payload.rescheduleUid || payload.metadata?.rescheduleUid;
  if (!newUid) return;

  // Idempotency: if new UID already exists, never increment again.
  const newRows = await supabaseFetch(
    `/bookings?cal_booking_id=eq.${encodeURIComponent(newUid)}&select=reschedule_count&limit=1`
  ).catch(() => []);
  const existingNew = Array.isArray(newRows) && newRows.length ? newRows[0] : null;

  let oldBooking = null;
  if (oldUid) {
    const oldRows = await supabaseFetch(
      `/bookings?cal_booking_id=eq.${encodeURIComponent(oldUid)}&select=user_id,user_email,event_type,reschedule_count,start_time&limit=1`
    ).catch(() => []);
    oldBooking = Array.isArray(oldRows) && oldRows.length ? oldRows[0] : null;
  }

  const oldRescheduleCount = oldBooking?.reschedule_count || 0;
  const rescheduleCount = existingNew
    ? (existingNew.reschedule_count || 0)
    : (oldRescheduleCount + 1);

  // Upsert the new booking as scheduled, inheriting the incremented reschedule_count
  const attendeeEmail = extractAttendeeEmail(payload) || oldBooking?.user_email || '';
  const eventSlug = extractEventSlug(payload) || oldBooking?.event_type || null;
  let userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;
  if (!userId && oldBooking?.user_id) userId = oldBooking.user_id;

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
    reschedule_count: rescheduleCount,
    join_url: extractJoinUrl(payload),
    cancel_url: cancelUrl,
    reschedule_url: rescheduleUrl,
    raw_payload: payload,
  });

  if (oldUid && oldUid !== newUid) {
    await supabaseFetch(`/bookings?cal_booking_id=eq.${encodeURIComponent(oldUid)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    }).catch(() => {});
  }
}

async function handleBookingEnded(body) {
  const uid = body?.payload?.uid ?? body?.uid;
  if (!uid) return;

  const rawPayload = body?.payload || body;

  await supabaseFetch(`/bookings?cal_booking_id=eq.${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'completed',
      completed_at: new Date().toISOString(),
      raw_payload: rawPayload,
    }),
  }).catch(() => {});
}

async function handleBookingRequested(payload) {
  const uid = payload.uid;
  if (!uid) return;

  const attendeeEmail = extractAttendeeEmail(payload);
  const userId = attendeeEmail ? await findUserByEmail(attendeeEmail) : null;
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
    status: 'requested',
    join_url: extractJoinUrl(payload),
    cancel_url: cancelUrl,
    reschedule_url: rescheduleUrl,
    raw_payload: payload,
  });
}

async function handleBookingRejected(payload) {
  const uid = payload.uid;
  if (!uid) return;

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
    status: 'rejected',
    join_url: null,
    cancel_url: null,
    reschedule_url: null,
    raw_payload: payload,
  });

  // Recurring rejection propagation: mark sibling occurrences as rejected too
  if (payload.recurringEvent && payload.bookingId) {
    await propagateRecurringRejection(payload, userId, attendeeEmail, uid);
  }
}

async function propagateRecurringRejection(payload, userId, attendeeEmail, rejectedUid) {
  const rejectedBookingId  = payload.bookingId;
  const rejectedEventTypeId = payload.eventTypeId;
  const rejectedStartTime  = new Date(payload.startTime);
  const rejectedEndTime    = new Date(payload.endTime);
  const rejectedDurationMs = rejectedEndTime - rejectedStartTime;
  const rejectedMinuteOfDay =
    rejectedStartTime.getUTCHours() * 60 + rejectedStartTime.getUTCMinutes();

  // Build user filter; prefer user_id, fall back to user_email
  let userFilter;
  if (userId) {
    userFilter = `user_id=eq.${encodeURIComponent(userId)}`;
  } else if (attendeeEmail) {
    userFilter = `user_email=eq.${encodeURIComponent(attendeeEmail)}`;
  } else {
    return;
  }

  // Fetch candidate bookings: same user, same or future start_time, still pending
  // Search within 90 days to cover typical recurring-series lengths (e.g. 12 weekly sessions ≈ 84 days)
  const RECURRING_REJECTION_WINDOW_DAYS = 90;
  const windowEnd = new Date(
    rejectedStartTime.getTime() + RECURRING_REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const candidates = await supabaseFetch(
    `/bookings?${userFilter}` +
    `&cal_booking_id=neq.${encodeURIComponent(rejectedUid)}` +
    `&start_time=gte.${encodeURIComponent(payload.startTime)}` +
    `&start_time=lte.${encodeURIComponent(windowEnd)}` +
    `&status=in.(scheduled,requested)` +
    `&select=id,start_time,end_time,raw_payload`
  ).catch(() => []);

  if (!Array.isArray(candidates) || !candidates.length) return;

  // Cal.com assigns consecutive numeric bookingIds to occurrences created in the same batch.
  // A window of ±10 is broad enough to catch all occurrences in a typical series while
  // still being narrow enough to avoid matching unrelated bookings from other students.
  const BOOKING_ID_WINDOW = 10;
  const siblingIds = [];

  for (const c of candidates) {
    const raw = c.raw_payload || {};

    // bookingId must be within ±10 of the rejected payload's bookingId
    const cBookingId = typeof raw.bookingId === 'number' ? raw.bookingId : null;
    if (cBookingId === null || Math.abs(cBookingId - rejectedBookingId) > BOOKING_ID_WINDOW) continue;

    // eventTypeId must match (if present)
    if (rejectedEventTypeId && raw.eventTypeId !== rejectedEventTypeId) continue;

    // Same time-of-day (UTC hour + minute)
    const cStart = new Date(c.start_time);
    const cMinuteOfDay = cStart.getUTCHours() * 60 + cStart.getUTCMinutes();
    if (cMinuteOfDay !== rejectedMinuteOfDay) continue;

    // Same duration
    const cEnd = new Date(c.end_time);
    if ((cEnd - cStart) !== rejectedDurationMs) continue;

    siblingIds.push(c.id);
  }

  if (!siblingIds.length) return;

  await supabaseFetch(
    `/bookings?id=in.(${siblingIds.join(',')})`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'rejected' }),
    }
  ).catch((err) => {
    console.error('propagateRecurringRejection: failed to update siblings:', err);
  });

  console.log(
    `Recurring rejection propagated: updated ${siblingIds.length} sibling booking(s) to rejected for uid=${rejectedUid}`
  );
}

async function propagateRecurringAccepted(payload, userId, attendeeEmail, acceptedUid) {
  const acceptedBookingId = payload.bookingId;
  const acceptedEventTypeId = payload.eventTypeId;
  const acceptedStartTime = new Date(payload.startTime);
  const acceptedEndTime = new Date(payload.endTime);
  const acceptedDurationMs = acceptedEndTime - acceptedStartTime;
  const acceptedMinuteOfDay =
    acceptedStartTime.getUTCHours() * 60 + acceptedStartTime.getUTCMinutes();
  const acceptedJoinUrl = extractJoinUrl(payload);

  // Build user filter; prefer user_id, fall back to user_email
  let userFilter;
  if (userId) {
    userFilter = `user_id=eq.${encodeURIComponent(userId)}`;
  } else if (attendeeEmail) {
    userFilter = `user_email=eq.${encodeURIComponent(attendeeEmail)}`;
  } else {
    return;
  }

  if (!acceptedEventTypeId) return;

  // Fetch candidate bookings: same user, same or future start_time, still requested
  // Search within 90 days to cover typical recurring-series lengths (e.g. 12 weekly sessions ≈ 84 days)
  const RECURRING_ACCEPTED_WINDOW_DAYS = 90;
  const windowEnd = new Date(
    acceptedStartTime.getTime() + RECURRING_ACCEPTED_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const candidates = await supabaseFetch(
    `/bookings?${userFilter}` +
    `&cal_booking_id=neq.${encodeURIComponent(acceptedUid)}` +
    `&start_time=gte.${encodeURIComponent(payload.startTime)}` +
    `&start_time=lte.${encodeURIComponent(windowEnd)}` +
    `&status=eq.requested` +
    `&select=id,start_time,end_time,raw_payload`
  ).catch(() => []);

  if (!Array.isArray(candidates) || !candidates.length) return;

  // Cal.com assigns consecutive numeric bookingIds to occurrences created in the same batch.
  // A window of ±10 is broad enough to catch all occurrences in a typical series while
  // still being narrow enough to avoid matching unrelated bookings from other students.
  const BOOKING_ID_WINDOW = 10;
  const siblingIds = [];

  for (const c of candidates) {
    const raw = c.raw_payload || {};

    // bookingId must be within ±10 of the accepted payload's bookingId
    const cBookingId = typeof raw.bookingId === 'number' ? raw.bookingId : null;
    if (cBookingId === null || Math.abs(cBookingId - acceptedBookingId) > BOOKING_ID_WINDOW) continue;

    // eventTypeId must match
    if (raw.eventTypeId !== acceptedEventTypeId) continue;

    // Same time-of-day (UTC hour + minute)
    const cStart = new Date(c.start_time);
    const cMinuteOfDay = cStart.getUTCHours() * 60 + cStart.getUTCMinutes();
    if (cMinuteOfDay !== acceptedMinuteOfDay) continue;

    // Same duration
    const cEnd = new Date(c.end_time);
    if ((cEnd - cStart) !== acceptedDurationMs) continue;

    siblingIds.push(c.id);
  }

  if (!siblingIds.length) return;

  const patchBody = { status: 'scheduled' };
  if (acceptedJoinUrl) patchBody.join_url = acceptedJoinUrl;
  await supabaseFetch(
    `/bookings?id=in.(${siblingIds.join(',')})`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patchBody),
    }
  ).catch((err) => {
    console.error('propagateRecurringAccepted: failed to update siblings:', err);
  });

  console.log(
    `Recurring accepted propagated: updated ${siblingIds.length} sibling booking(s) to scheduled for uid=${acceptedUid}`
  );
}

async function propagateRecurringCancellation(payload, userId, attendeeEmail, cancelledUid) {
  const cancelledBookingId = payload.bookingId;
  const cancelledEventTypeId = payload.eventTypeId;
  const cancelledStartTime = new Date(payload.startTime);
  const cancelledEndTime = new Date(payload.endTime);
  const cancelledDurationMs = cancelledEndTime - cancelledStartTime;
  const cancelledMinuteOfDay =
    cancelledStartTime.getUTCHours() * 60 + cancelledStartTime.getUTCMinutes();

  // Build user filter; prefer user_id, fall back to user_email
  let userFilter;
  if (userId) {
    userFilter = `user_id=eq.${encodeURIComponent(userId)}`;
  } else if (attendeeEmail) {
    userFilter = `user_email=eq.${encodeURIComponent(attendeeEmail)}`;
  } else {
    return;
  }

  if (!cancelledEventTypeId) return;

  // Fetch candidate bookings: same user, same or future start_time, still pending-ish
  // Search within 90 days to cover typical recurring-series lengths (e.g. 12 weekly sessions ≈ 84 days)
  const RECURRING_CANCELLATION_WINDOW_DAYS = 90;
  const windowEnd = new Date(
    cancelledStartTime.getTime() + RECURRING_CANCELLATION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const candidates = await supabaseFetch(
    `/bookings?${userFilter}` +
    `&cal_booking_id=neq.${encodeURIComponent(cancelledUid)}` +
    `&start_time=gte.${encodeURIComponent(payload.startTime)}` +
    `&start_time=lte.${encodeURIComponent(windowEnd)}` +
    `&status=in.(scheduled,requested)` +
    `&select=id,start_time,end_time,raw_payload`
  ).catch(() => []);

  if (!Array.isArray(candidates) || !candidates.length) return;

  // Cal.com assigns consecutive numeric bookingIds to occurrences created in the same batch.
  // A window of ±10 is broad enough to catch all occurrences in a typical series while
  // still being narrow enough to avoid matching unrelated bookings from other students.
  const BOOKING_ID_WINDOW = 10;
  const siblingIds = [];

  for (const c of candidates) {
    const raw = c.raw_payload || {};

    // bookingId must be within ±10 of the cancelled payload's bookingId
    const cBookingId = typeof raw.bookingId === 'number' ? raw.bookingId : null;
    if (cBookingId === null || Math.abs(cBookingId - cancelledBookingId) > BOOKING_ID_WINDOW) continue;

    // eventTypeId must match
    if (raw.eventTypeId !== cancelledEventTypeId) continue;

    // Same time-of-day (UTC hour + minute)
    const cStart = new Date(c.start_time);
    const cMinuteOfDay = cStart.getUTCHours() * 60 + cStart.getUTCMinutes();
    if (cMinuteOfDay !== cancelledMinuteOfDay) continue;

    // Same duration
    const cEnd = new Date(c.end_time);
    if ((cEnd - cStart) !== cancelledDurationMs) continue;

    siblingIds.push(c.id);
  }

  if (!siblingIds.length) return;

  await supabaseFetch(
    `/bookings?id=in.(${siblingIds.join(',')})`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'cancelled' }),
    }
  ).catch((err) => {
    console.error('propagateRecurringCancellation: failed to update siblings:', err);
  });

  console.log(
    `Recurring cancellation propagated: updated ${siblingIds.length} sibling booking(s) to cancelled for uid=${cancelledUid}`
  );
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
    } else if (trigger === 'BOOKING_MEETING_ENDED' || trigger === 'MEETING_ENDED') {
      await handleBookingEnded(parsed);
    } else if (trigger === 'BOOKING_REQUESTED') {
      await handleBookingRequested(payload);
    } else if (trigger === 'BOOKING_REJECTED') {
      await handleBookingRejected(payload);
    } else {
      console.log(`Unhandled trigger: ${trigger}`);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('cal-webhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
