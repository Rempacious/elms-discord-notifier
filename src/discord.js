'use strict';
/**
 * Discord delivery: rich embeds per notification, batched, with thread support and
 * a de-duplicated alert path for operational problems.
 */
const crypto = require('crypto');
const { cfg } = require('./config');
const { loadState, saveState } = require('./notifications');

function severity(item) {
  const s = (item.subject || '').toLowerCase();
  if (/due soon|deadline|due today|overdue/.test(s)) return { color: 16734296, icon: '\u23f0' };
  if (/graded|score|points|grade/.test(s)) return { color: 5793266, icon: '\ud83d\udcdd' };
  if (/awarded|badge|certificate|completed/.test(s)) return { color: 10181046, icon: '\ud83c\udfc6' };
  if (/message|replied|commented|post/.test(s)) return { color: 3066993, icon: '\ud83d\udcac' };
  if (/announce|news|module|added/.test(s)) return { color: 3447003, icon: '\ud83d\udce2' };
  return { color: 9807270, icon: '\ud83d\udd14' };
}

function embedFor(item) {
  const { color, icon } = severity(item);
  const title = item.subject.length > 250 ? item.subject.slice(0, 247) + '\u2026' : item.subject;
  const e = {
    title: `${icon} ${title}`,
    url: `${cfg.baseUrl}/notifications/show?notification=${item.id}`,
    color,
    footer: { text: `eLMS \u00b7 ${item.time || 'now'}` },
  };
  if (item.from) e.author = { name: item.from };
  return e;
}

async function post(payload) {
  if (!cfg.webhook) throw new Error('DISCORD_WEBHOOK_URL is not set - run `npm run setup`');
  const q = new URLSearchParams({ wait: 'true' });
  if (cfg.threadId) q.set('thread_id', cfg.threadId); // webhook posts into a thread only with this param
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${cfg.webhook}?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, // default urllib UA gets Cloudflare-1010'd
      body: JSON.stringify(payload),
    });
    if (res.ok) return res.json();
    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (attempt === 3 || !retryable) throw new Error(`discord ${res.status}: ${body.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

/** Post an operational alert at most once per distinct problem. */
async function alertOnce(kind, text) {
  const state = loadState();
  const hash = crypto.createHash('sha1').update(kind + text).digest('hex').slice(0, 12);
  if (state.alertHash === hash) return false;
  await post({ embeds: [{ title: '\u26a0\ufe0f eLMS bridge', description: text, color: 15158332 }] });
  state.alertHash = hash;
  saveState(state);
  return true;
}

module.exports = { post, embedFor, alertOnce, severity };
