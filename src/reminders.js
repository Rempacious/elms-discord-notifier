'use strict';
/**
 * Deadline reminders: ping once when a submission is ~N hours from its deadline, then keep
 * nagging every M minutes while it is still not submitted.
 *
 * Source of truth is the LMS calendar agenda, which carries the due date, the due time and a
 * per-item "submitted / nothing submitted yet" status.
 */
const fs = require('fs');
const path = require('path');
const { cfg } = require('./config');
const { postMentionEmbed } = require('./discord');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STORE = path.join(cfg.dataDir, 'reminders.json');
const STORE_MAX_AGE = 45 * 86400000;

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function saveStore(store) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 1));
}

// ---------- scraping ----------
async function scrapeWeek(page, advance) {
  await page.goto(`${cfg.baseUrl}/my_calendar/index?mode=agenda`, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
  await page.waitForTimeout(1200);
  for (let i = 0; i < advance; i++) {
    await page.evaluate(() => { if (typeof next_calendar === 'function') next_calendar(); });
    await page.waitForTimeout(2500);
  }
  const year = Number((page.url().match(/year=(\d{4})/) || [, new Date().getFullYear()])[1]);
  const raw = await page.evaluate(() => {
    const out = [];
    for (const day of document.querySelectorAll('.calendar-agenda-day')) {
      const heading = (day.querySelector('.day-heading') || {}).innerText || '';
      for (const ev of day.querySelectorAll('.calendar-agenda-event')) {
        const time = ((ev.querySelector(':scope > span') || {}).innerText || '').trim();
        const course = ((ev.querySelector('a.focusable') || {}).innerText || '').trim().replace(/\s+/g, ' ');
        for (const li of ev.querySelectorAll('ul li')) {
          const text = (li.innerText || '').trim().replace(/\s+/g, ' ');
          if (!text) continue;
          const onclick = (li.querySelector('a') || {}).getAttribute ? (li.querySelector('a').getAttribute('onclick') || '') : '';
          const link = (onclick.match(/'([^']+)'/) || [])[1] || '';
          out.push({ heading, time, course, text, link });
        }
      }
    }
    return out;
  });
  return raw.map((r) => Object.assign(r, { year }));
}

function parseDue(heading, time, year) {
  const dm = (heading || '').match(/([A-Za-z]{3})\w*\s+(\d{1,2})/);
  const tm = (time || '').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!dm || !tm) return null;
  const mi = MONTHS.findIndex((m) => m.toLowerCase() === dm[1].toLowerCase());
  if (mi < 0) return null;
  let h = Number(tm[1]) % 12;
  if (/pm/i.test(tm[3] || '')) h += 12;
  // the LMS reports local time (Asia/Manila, UTC+8)
  return Date.UTC(year, mi, Number(dm[2]), h - 8, Number(tm[2] || 0), 0);
}

/** Every dated item in the current + next calendar week, with submission state. */
async function collectDeadlines(page) {
  const rows = [];
  for (const advance of [0, 1]) {
    const raw = await scrapeWeek(page, advance);
    for (const r of raw) {
      const dueAt = parseDue(r.heading, r.time, r.year);
      if (!dueAt) continue;
      const open = /(nothing|not)\s+submitted\s+yet/i.test(r.text);
      const submitted = !open && /submitted$/i.test(r.text);
      const item = r.text.replace(/\s*((nothing|not)\s+submitted\s+yet|submitted)$/i, '').trim();
      const course = r.course.replace(/\s*-\s*SY\d{4}-\dT$/i, '');
      rows.push({
        key: `${course}|${item}|${new Date(dueAt).toISOString().slice(0, 10)}`,
        course,
        item,
        dueAt,
        submitted,
        link: r.link ? cfg.baseUrl + r.link : '',
      });
    }
  }
  // de-duplicate (same item can appear in both week views)
  const seen = new Map();
  for (const r of rows) seen.set(r.key, r);
  return [...seen.values()].sort((a, b) => a.dueAt - b.dueAt);
}

// ---------- rules ----------
function human(ms) {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.round((abs % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Decide what to ping now.
 * - first ping when <= REMINDER_LEAD_HOURS before the deadline and still unsubmitted
 * - repeat every REMINDER_REPEAT_MINUTES while still unsubmitted
 * - stop REMINDER_AFTER_DUE_HOURS past the deadline
 */
function dueReminders(deadlines, store, now = Date.now()) {
  const lead = cfg.reminderLeadHours * 3600000;
  const repeat = cfg.reminderRepeatMinutes * 60000;
  const grace = cfg.reminderAfterDueHours * 3600000;
  const actions = [];

  for (const d of deadlines) {
    const st = store[d.key] || (store[d.key] = {});
    if (d.submitted) {
      if (!st.submittedAt) st.submittedAt = now;
      st.pending = false;
      continue;
    }
    if (st.submittedAt) {           // was submitted, then reopened - start the cycle again
      st.submittedAt = null;
      st.firstPingAt = null;
      st.lastPingAt = null;
    }
    st.pending = true;
    if (now > d.dueAt + grace) continue;          // too late to nag
    if (now < d.dueAt - lead) continue;           // too early

    if (!st.firstPingAt) {
      st.firstPingAt = now;
      st.lastPingAt = now;
      st.count = 1;
      actions.push(Object.assign({}, d, { kind: 'first', remaining: d.dueAt - now }));
    } else if (now - (st.lastPingAt || 0) >= repeat) {
      st.lastPingAt = now;
      st.count = (st.count || 1) + 1;
      actions.push(Object.assign({}, d, { kind: 'repeat', remaining: d.dueAt - now, count: st.count }));
    }
  }

  // prune old entries
  for (const [k, v] of Object.entries(store)) {
    const ts = v.lastPingAt || v.submittedAt;
    if (ts && now - ts > STORE_MAX_AGE) delete store[k];
  }
  return actions;
}

function containerFor(action) {
  const overdue = action.remaining < 0;
  const urgent = action.remaining <= 3600000;
  const accent = overdue ? 0xed4245 : urgent ? 0xf5a623 : 0x5865f2;
  const headline = overdue
    ? `### ⚠️ Overdue by ${human(action.remaining)}`
    : `### ⏰ Due in ${human(action.remaining)}`;
  const when = new Date(action.dueAt).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const blocks = [
    { type: 10, content: headline },
    { type: 10, content: `**${action.item}**\n-# ${action.course} · ${when}` },
  ];
  if (action.kind === 'repeat') {
    blocks.push({ type: 10, content: `-# reminder #${action.count} · still not submitted` });
  } else {
    blocks.push({ type: 10, content: '-# not submitted yet — first reminder' });
  }
  if (action.link) {
    blocks.push({ type: 1, components: [{ type: 2, style: 5, label: 'Open assignment', url: action.link }] });
  }
  return { type: 17, accent_color: accent, components: blocks };
}

/** Embed for a reminder ping (a real mention needs message content, which Components V2 forbids). */
function embedForAction(action) {
  const overdue = action.remaining < 0;
  const urgent = action.remaining <= 3600000;
  const when = new Date(action.dueAt).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const headline = overdue ? `⚠️ Overdue by ${human(action.remaining)}` : `⏰ Due in ${human(action.remaining)}`;
  const note = action.kind === 'repeat'
    ? `reminder #${action.count} · still not submitted`
    : 'not submitted yet — first reminder';
  return {
    title: headline,
    description: `**${action.item}**\n${action.course}\n🕒 ${when}`,
    color: overdue ? 0xed4245 : urgent ? 0xf5a623 : 0x5865f2,
    url: action.link || undefined,
    footer: { text: `STI eLMS · ${note}` },
    timestamp: new Date().toISOString(),
  };
}

async function sendReminders(actions) {
  const sent = [];
  for (const a of actions) {
    const msg = await postMentionEmbed(embedForAction(a), cfg.discordUserId);
    sent.push({ key: a.key, id: msg && msg.id, kind: a.kind });
  }
  return sent;
}

module.exports = { collectDeadlines, dueReminders, containerFor, embedForAction, sendReminders, loadStore, saveStore, parseDue, human };
