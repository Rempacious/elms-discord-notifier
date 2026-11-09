'use strict';
/**
 * Fully unattended re-login for the Entra SSO flow, used when the saved cookies have expired
 * (the silent bounce only works while the identity-provider session is alive).
 *
 * Requires three optional values in .env:
 *   ELMS_USER           student number / email used on the Microsoft sign-in page
 *   ELMS_PASSWORD       account password
 *   ELMS_TOTP_SECRET    base32 authenticator seed (or otpauth:// URI) for the 6-digit code
 *
 * Self-test the TOTP implementation:  node src/auto-login.js --selftest
 */
const crypto = require('crypto');
const { cfg } = require('./config');

// ---------- TOTP (RFC 6238, SHA-1) ----------
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, { digits = 6, period = 30, at = Date.now() } = {}) {
  const key = base32Decode(secret);
  const counter = Math.floor(at / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** Accept a bare base32 seed or an otpauth:// URI (digits/period honoured). */
function parseSecret(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^otpauth:\/\//i.test(s)) {
    const u = new URL(s.replace(/^otpauth:/i, 'otpauth:').replace('://totp/', '://totp/'));
    const secret = u.searchParams.get('secret') || '';
    return {
      secret,
      digits: Number(u.searchParams.get('digits') || 6),
      period: Number(u.searchParams.get('period') || 30),
    };
  }
  return { secret: s, digits: 6, period: 30 };
}

// ---------- login flow ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickTileFor(page, user) {
  const rect = await page.evaluate((needle) => {
    const tiles = [...document.querySelectorAll('.tile, #tilesHolder div, [data-test-id=tile]')];
    const t = tiles.find((e) => (e.innerText || '').toLowerCase().includes(needle.toLowerCase()));
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, user);
  if (!rect) return false;
  await page.mouse.click(rect.x, rect.y);
  return true;
}

async function clickText(page, re) {
  try {
    return await page.evaluate((pattern) => {
      const rx = new RegExp(pattern, 'i');
      const el = [...document.querySelectorAll('a,button,input')].find((e) => rx.test((e.textContent || '') + (e.value || '')));
      if (!el) return false;
      el.click();
      return true;
    }, re.source);
  } catch {
    return false;   // page navigated under us - caller retries
  }
}

/**
 * Walk the whole SSO flow. Returns {ok, url, step}.
 * Throws only on missing configuration.
 */
async function autoLogin(page, { user, password, totpSecret } = {}) {
  const u = user || cfg.env.ELMS_USER;
  const p = password || cfg.env.ELMS_PASSWORD;
  const s = parseSecret(totpSecret || cfg.env.ELMS_TOTP_SECRET);
  if (!u || !p) throw new Error('ELMS_USER / ELMS_PASSWORD not set in .env');

  const log = [];
  const step = (name) => { log.push(name); console.error('[auto-login]', name); };

  await page.goto(cfg.baseUrl + '/log_in/form', { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
  step('open login page');

  // hand off to the identity provider
  await page.evaluate(() => {
    const f = document.querySelector('form#sso');
    if (f) { f.action = '/auth/microsoft_office365'; f.method = 'post'; f.submit(); }
  });
  await sleep(5000);
  step('idp');

  // account picker / email entry
  if (await clickTileFor(page, u)) { step('picked account tile'); await sleep(5000); }
  const emailField = await page.$('input[name=loginfmt]');
  if (emailField) {
    await emailField.fill(u);
    await sleep(300);
    await page.click('#idSIButton9').catch(() => { });
    await sleep(4500);
    step('email submitted');
  }

  // password
  const pw = await page.$('input[name=passwd]');
  if (pw) {
    await pw.fill(p);
    await sleep(300);
    await page.click('#idSIButton9').catch(() => { });
    await sleep(6000);
    step('password submitted');
  }

  // one-time code
  const otc = await page.$('input[autocomplete=one-time-code], input[name=otc]');
  if (otc) {
    if (!s || !s.secret) {
      return { ok: false, url: page.url(), step: 'otp-required-no-secret', log };
    }
    const code = totp(s.secret, { digits: s.digits, period: s.period });
    await otc.fill(code);
    await sleep(300);
    await page.click('#idSubmit_SAOTCC_Continue, #idSIButton9').catch(() => { });
    await sleep(6500);
    step('otp submitted');
  }

  // authenticator upsell
  const settle = async () => { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { }); };
  const retry = async (fn, attempts = 3) => {
    for (let i = 0; i < attempts; i++) {
      try { const r = await fn(); if (r) return r; } catch { /* context destroyed mid-navigation */ }
      await sleep(1500);
      await settle();
    }
    return null;
  };

  await settle();
  await retry(() => clickText(page, /skip for now/));
  await sleep(2000);
  await settle();

  // "stay signed in?" - always yes, it is what keeps the next re-auth silent
  const kmsi = await retry(() => page.evaluate(() => /Stay signed in\?/i.test(document.body.innerText)), 2);
  if (kmsi) {
    await retry(() => page.click('#idSIButton9').then(() => true));
    await sleep(6000);
    step('kmsi accepted');
  }

  // land back in the LMS
  for (let i = 0; i < 12; i++) {
    if (!/login\.microsoftonline|accounts\.google/i.test(page.url())) break;
    await sleep(2000);
  }
  await page.goto(cfg.baseUrl + '/notifications', { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs }).catch(() => { });
  await sleep(1500);
  const ok = !/log_in|not_logged_in|simultaneous_logins/.test(page.url());
  step(ok ? 'logged in' : 'still logged out');
  return { ok, url: page.url(), log };
}

module.exports = { autoLogin, totp, base32Decode, parseSecret };

// CLI
//   node src/auto-login.js              self-test the TOTP implementation (RFC 6238 vectors)
//   node src/auto-login.js --run        perform a real login now and save the cookies
if (require.main === module) {
  if (process.argv.includes('--run')) {
    const { openSession, saveCookies } = require('./browser');
    (async () => {
      const { browser, ctx, page } = await openSession({ headless: false });
      try {
        const res = await autoLogin(page);
        console.log(JSON.stringify(res, null, 1));
        if (res.ok) console.log('cookies saved:', await saveCookies(ctx));
        process.exit(res.ok ? 0 : 1);
      } finally {
        await browser.close();
      }
    })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
  } else {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const cases = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1234567890, '89005924'],
    ];
    let pass = 0;
    for (const [at, want] of cases) {
      const got = totp(secret, { digits: 8, at: at * 1000 });
      const ok = got === want;
      if (ok) pass++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} t=${at} got=${got} want=${want}`);
    }
    console.log(`${pass}/${cases.length} vectors passed`);
    process.exit(pass === cases.length ? 0 : 1);
  }
}
