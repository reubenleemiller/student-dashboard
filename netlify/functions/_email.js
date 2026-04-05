'use strict';

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function getSiteTitle() {
  return process.env.SITE_TITLE || 'RM Tutoring';
}

function getSiteUrl() {
  return (process.env.SITE_URL || '').replace(/\/$/, '');
}

function buildFromEmail() {
  if (process.env.RESEND_FROM_EMAIL) return process.env.RESEND_FROM_EMAIL;
  const siteTitle = getSiteTitle();
  const siteUrl = getSiteUrl();
  try {
    const hostname = new URL(siteUrl).hostname;
    return `${siteTitle} <noreply@${hostname}>`;
  } catch {
    return `${siteTitle} <noreply@example.com>`;
  }
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: buildFromEmail(),
        to,
        subject,
        html,
      }),
    });

    if (!res.ok) {
      console.error('_email: Resend error', res.status, await res.text());
      return false;
    }

    return true;
  } catch (err) {
    console.error('_email: send failed', err);
    return false;
  }
}

module.exports = { sendEmail, escHtml, getSiteTitle, getSiteUrl };