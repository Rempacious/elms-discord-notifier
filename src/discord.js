'use strict';
/**
 * Discord delivery.
 *
 * Messages use Discord's Components V2 layout (container + accent bar + text displays +
 * separator + a link button) for a modern look; if the target client/webhook rejects that
 * payload we fall back to classic rich embeds and remember the choice in state.json.
 */
const crypto = require('crypto');
const { cfg } = require('./config');
const { loadState, saveState } = require('./notifications');

const V2_FLAG = 1 << 15; // MessageFlags.IS_COMPONENTS_V2
const MAX_CHARS = 3800;  // keep each message well under Discord's 4000-char content ceiling

// ---------- classification ----------
function classify(item) {
  const s = (item.subject || '').toLowerCase();
  if (/due soon|due today|overdue|deadline/.test(s)) return { key: 'due', label: 'Due soon', icon: '\u23f0', color: 0xf5a623 };
  if (/graded/.test(s)) return { key: 'graded', label: 'Graded', icon: '\ud83d\udcdd', color: 0x5865f2 };
  if (/awarded|points|badge|certificate/.test(s)) return { key: 'award', label: 'Points awarded', icon: '\ud83c\udfc6', color: 0x9b59b6 };
  if (/message|replied|commented|mentioned/.test(s)) return { key: 'message', label: 'Message', icon: '\ud83d\udcac', color: 0x57f287 };
  if (/announce|news|module|new assignment|posted/.test(s)) return { key: 'news', label: 'Announcement', icon: '\ud83d\udce2', color: 0x3498db };
  return { key: 'other', label: 'Notification', icon: '\ud83d\udd14', color: 0x95a5a6 };
}

/** Pull the human-meaningful bits out of a Neo LMS subject line. */
function parseSubject(subject) {
  const quoted = subject.match(/'([^']+)'/);
  const course = subject.match(/in (?:class|course) '([^']+)'/i);
  const objectWord = subject.match(/^\s*(?:due soon|graded|new|updated|reminder|late)\s*:\s*([a-z ]+?)\s*'/i);
  const cleaned = subject.replace(/\s*in (?:class|course) '[^']*'\s*\.?$/i, '').replace(/\.\s*$/, '').replace(/\s+/g, ' ').trim();
  let headline;
  if (objectWord) {
    const word = objectWord[1].trim();
    headline = word.charAt(0).toUpperCase() + word.slice(1);
  } else {
    headline = cleaned;
  }
  const courseName = course ? course[1].trim() : '';
  const code = courseName.match(/\b([A-Z]{2,5}\d{2,5})\b/);
  return {
    headline,
    item: quoted ? quoted[1].trim() : '',
    course: courseName,
    courseCode: code ? code[1] : '',
    raw: cleaned,
  };
}

/** "Oct 21 3:41 pm" / "1:39 am" -> unix seconds (assumes the site's +08:00 local time). */
function parseWhen(timeStr, now = new Date()) {
  if (!timeStr) return null;
  const t = timeStr.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+)?(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  const [, mon, day, hh, mm, ap] = m;
  let hour = parseInt(hh, 10) % 12;
  if (/pm/i.test(ap)) hour += 12;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthIdx = mon ? months.indexOf(mon.toLowerCase()) : now.getUTCMonth();
  if (monthIdx < 0) return null;
  const year = now.getUTCFullYear();
  // build as Asia/Manila (UTC+8)
  let ms = Date.UTC(year, monthIdx, day ? parseInt(day, 10) : now.getUTCDate(), hour - 8, parseInt(mm, 10));
  if (ms > now.getTime() + 86400000) ms -= 365.25 * 86400000; // a date in the future = last year
  return Math.floor(ms / 1000);
}

// ---------- Components V2 ----------
function containerFor(item) {
  const kind = classify(item);
  const p = parseSubject(item.subject);
  const ts = parseWhen(item.time);
  const recent = ts && Math.abs(Date.now() / 1000 - ts) < 12 * 3600;
  const when = ts ? `<t:${ts}:${recent ? 'R' : 'f'}>` : (item.time || 'now');

  const blocks = [
    { type: 10, content: `${kind.icon} **${kind.label}**` },
    { type: 10, content: `### ${p.item || p.raw}` },
  ];
  if (p.course) blocks.push({ type: 10, content: `-# \ud83d\udcda ${p.course}` });
  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({
    type: 10,
    content: [item.from ? `**${item.from}**` : '', when].filter(Boolean).join('  \u00b7  '),
  });
  blocks.push({
    type: 1,
    components: [{
      type: 2, style: 5, label: 'Open in eLMS',
      url: `${cfg.baseUrl}/notifications/show?notification=${item.id}`,
    }],
  });

  return { type: 17, accent_color: kind.color, components: blocks };
}

function v2Payload(items) {
  return { flags: V2_FLAG, components: items.map(containerFor), allowed_mentions: { parse: [] } };
}

// ---------- classic embeds (fallback) ----------
function embedFor(item) {
  const kind = classify(item);
  const p = parseSubject(item.subject);
  const ts = parseWhen(item.time);
  const title = item.subject.length > 250 ? item.subject.slice(0, 247) + '\u2026' : item.subject;
  const e = {
    title: `${kind.icon} ${title}`,
    url: `${cfg.baseUrl}/notifications/show?notification=${item.id}`,
    color: kind.color,
    author: { name: `${kind.label}${item.from ? ` \u00b7 ${item.from}` : ''}` },
    footer: { text: 'eLMS' },
  };
  if (ts) e.timestamp = new Date(ts * 1000).toISOString();
  if (p.course) e.description = `\ud83d\udcda **${p.course}**\n> ${item.time || ''}`;
  return e;
}

// ---------- transport ----------
function withQuery(extra) {
  const q = new URLSearchParams({ wait: 'true' });
  if (cfg.threadId) q.set('thread_id', cfg.threadId);
  for (const [k, v] of Object.entries(extra || {})) if (v) q.set(k, v);
  return `${cfg.webhook}?${q}`;
}

async function send(payload, { components = false } = {}) {
  if (!cfg.webhook) throw new Error('DISCORD_WEBHOOK_URL is not set - run `npm run setup`');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(withQuery(components ? { with_components: 'true' } : {}), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res.json();
    const body = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (attempt === 3 || !retryable) {
      const err = new Error(`discord ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

function uiMode() {
  const state = loadState();
  return state.uiMode || 'v2';
}
function setUiMode(mode) {
  const state = loadState();
  state.uiMode = mode;
  saveState(state);
}

/** Post notifications, newest last-ish, chunked by character budget. */
async function postItems(items) {
  if (!items.length) return [];
  const results = [];
  let mode = uiMode();
  let batch = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const current = batch;
    batch = [];
    size = 0;
    if (mode === 'v2') {
      try {
        results.push(await send(v2Payload(current), { components: true }));
        return;
      } catch (e) {
        if (e.status === 400) {
          // client or API rejected the V2 layout - degrade once, then stay on embeds
          console.error('components v2 rejected, falling back to embeds:', e.body && e.body.slice(0, 160));
          setUiMode('embed');
          mode = 'embed';
        } else {
          throw e;
        }
      }
    }
    results.push(await send({ embeds: current.map(embedFor) }));
  };

  for (const item of items) {
    const approx = Math.min(900, 220 + (item.subject || '').length + (item.from || '').length);
    if (batch.length >= 5 || size + approx > MAX_CHARS) await flush();
    batch.push(item);
    size += approx;
  }
  await flush();
  return results;
}

async function postOne(item) {
  const out = await postItems([item]);
  return out[out.length - 1];
}

/** Post an operational alert at most once per distinct problem. */
async function alertOnce(kind, text) {
  const state = loadState();
  const hash = crypto.createHash('sha1').update(kind + text).digest('hex').slice(0, 12);
  if (state.alertHash === hash) return false;

  let sent = null;
  if (uiMode() === 'v2') {
    try {
      sent = await send({
        flags: V2_FLAG,
        components: [{
          type: 17,
          accent_color: 0xed4245,
          components: [
            { type: 10, content: '\u26a0\ufe0f **eLMS bridge needs attention**' },
            { type: 14, divider: true, spacing: 1 },
            { type: 10, content: text },
          ],
        }],
      }, { components: true });
    } catch (e) {
      if (e.status !== 400) throw e;
      setUiMode('embed');
    }
  }
  if (!sent) {
    await send({ embeds: [{ title: '\u26a0\ufe0f eLMS bridge', description: text, color: 15158332 }] });
  }

  const after = loadState();
  after.alertHash = hash;
  saveState(after);
  return true;
}

module.exports = { postItems, postOne, alertOnce, classify, parseSubject, parseWhen, embedFor, containerFor };
