#!/usr/bin/env node
'use strict';
/**
 * Daily schedule digest: scrapes the week's calendar + every course's open assignments,
 * renders a Discord-styled table to PNG and posts it to the channel.
 *
 *   node src/digest.js              post today's digest
 *   node src/digest.js --dry-run    build the PNG locally (./digest-preview.png) without posting
 *   node src/digest.js --text       post a monospace text table instead of an image
 */
const fs = require('fs');
const path = require('path');
const { cfg, ensureDirs } = require('./config');
const { openSession } = require('./browser');
const { postFile, postText, postContainers } = require('./discord');

const DRY = process.argv.includes('--dry-run');
const AS_TEXT = process.argv.includes('--text');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- scraping ----------
async function courseList(page) {
  await page.goto(cfg.baseUrl + '/user_dashboard', { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
  await page.waitForTimeout(1500);
  const courses = await page.evaluate(() => {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href^="/student_class/show/"]')) {
      const id = (a.getAttribute('href').match(/(\d+)\s*$/) || [])[1];
      const name = (a.textContent || '').trim().replace(/\s+/g, ' ');
      if (id && name && !seen.has(id)) seen.set(id, { id, name });
    }
    return [...seen.values()];
  });
  // skip administrative surveys: they have "open items" that are never real deadlines
  return courses.filter((c) => !/survey|evaluation|grade monitoring|community corner|guidance/i.test(c.name));
}

async function openWork(page, courses) {
  const rows = [];
  for (const c of courses) {
    const res = await page.goto(`${cfg.baseUrl}/student_assignments/due/${c.id}`, {
      waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs,
    }).catch(() => null);
    if (!res || res.status() !== 200) continue;
    await page.waitForTimeout(400);
    const items = await page.evaluate(() => {
      const out = [];
      for (const tr of document.querySelectorAll('table.assignmentsTable tr, table tr')) {
        const a = tr.querySelector('td.assignment a');
        if (!a) continue;
        const tds = Array.from(tr.querySelectorAll('td'));
        const startCell = tds.find((t) => /hideCell/.test(t.className) && /\d/.test(t.innerText));
        const cells = tds.map((t) => t.innerText.trim().replace(/\s+/g, ' '));
        out.push({
          title: a.textContent.trim().replace(/\s+/g, ' '),
          section: (tr.querySelector('td.assignment span a') || {}).textContent || '',
          start: startCell ? startCell.innerText.trim().replace(/\s+/g, ' ') : '',
          due: cells.length >= 4 ? cells[cells.length - 2] : '',
          score: cells.length ? cells[cells.length - 1] : '',
          href: a.getAttribute('href') || '',
        });
      }
      return out;
    });
    for (const it of items) rows.push(Object.assign({ course: c.name.replace(/\s*-\s*SY\d{4}-\dT$/, '') }, it));
  }
  return rows;
}

async function weekEvents(page, { advance = 0 } = {}) {
  await page.goto(`${cfg.baseUrl}/my_calendar/index?mode=agenda`, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
  await page.waitForTimeout(1200);
  for (let i = 0; i < advance; i++) {
    await page.evaluate(() => { if (typeof next_calendar === 'function') next_calendar(); });
    await page.waitForTimeout(2500);
  }
  const year = (page.url().match(/year=(\d{4})/) || [, String(new Date().getFullYear())])[1];
  const days = await page.evaluate(() => {
    const out = [];
    for (const day of document.querySelectorAll('.calendar-agenda-day')) {
      const heading = (day.querySelector('.day-heading') || {}).innerText || '';
      const events = [];
      for (const ev of day.querySelectorAll('.calendar-agenda-event')) {
        const time = (ev.querySelector(':scope > span') || {}).innerText || '';
        const course = (ev.querySelector('a.focusable') || {}).innerText || '';
        for (const li of ev.querySelectorAll('ul li')) {
          const text = (li.innerText || '').trim().replace(/\s+/g, ' ');
          if (!text) continue;
          const open = /(nothing|not)\s+submitted\s+yet/i.test(text);
          const done = !open && /submitted$/i.test(text);
          events.push({
            time: time.trim(),
            course: course.trim().replace(/\s+/g, ' '),
            item: text.replace(/\s*((nothing|not)\s+submitted\s+yet|submitted)$/i, '').trim(),
            status: done ? 'done' : open ? 'open' : '',
          });
        }
      }
      out.push({ heading: heading.replace(/\s+/g, ' ').trim(), events });
    }
    return out;
  });
  return { year: Number(year), days };
}

// ---------- shaping ----------
function dayDate(heading, year) {
  const m = heading.match(/([A-Za-z]{3})\w*\s+(\d{1,2})/);
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (mi < 0) return null;
  return new Date(Date.UTC(year, mi, Number(m[2])));
}

function minutes(t) {
  const m = (t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return 9999;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3] || '')) h += 12;
  return h * 60 + Number(m[2] || 0);
}

function fmtDate(d) {
  return d ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : '';
}

// ---------- native (mobile-first) components ----------
function digestContainers({ schedule, work, weekLabel, generated }) {
  const head = {
    type: 17,
    accent_color: 0x5865f2,
    components: [
      { type: 10, content: `## 📅 eLMS · ${weekLabel}` },
      { type: 10, content: `-# ${schedule.length} dated · ${work.length} open · ${generated}` },
      { type: 1, components: [{ type: 2, style: 5, label: 'Open calendar', url: `${cfg.baseUrl}/my_calendar` }] },
    ],
  };

  const sched = {
    type: 17,
    accent_color: 0xf5a623,
    components: [{ type: 10, content: '### ⏰ Next 7 days' }],
  };
  if (!schedule.length) sched.components.push({ type: 10, content: '-# nothing due — clear week 🎉' });
  schedule.forEach((r, i) => {
    if (i) sched.components.push({ type: 14, divider: true, spacing: 1 });
    const status = r.status === 'done' ? '✅ submitted' : '⏳ not submitted';
    sched.components.push({ type: 10, content: `**${r.day}** · ${r.time || '—'} · ${status}` });
    sched.components.push({ type: 10, content: `${r.course}\n-# ${r.item}` });
  });

  const open = {
    type: 17,
    accent_color: 0x9b59b6,
    components: [{ type: 10, content: '### 📋 Open work' }],
  };
  if (!work.length) open.components.push({ type: 10, content: '-# nothing outstanding 🎉' });
  work.forEach((r, i) => {
    if (i) open.components.push({ type: 14, divider: true, spacing: 1 });
    open.components.push({ type: 10, content: `**${r.course}** · due ${r.due || '—'} · ${(r.score || '?').replace('?/', '? / ')}` });
    open.components.push({ type: 10, content: `-# ${r.title}${r.section ? ` · ${r.section}` : ''}` });
  });

  return [head, sched, open];
}

// ---------- rendering ----------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function html({ weekLabel, generated, schedule, work }) {
  const rows = schedule.length
    ? schedule.map((r) => `
      <tr>
        <td class="day">${esc(r.day)}</td>
        <td class="time">${esc(r.time || '—')}</td>
        <td class="course">${esc(r.course)}</td>
        <td class="item">${esc(r.item)}</td>
        <td><span class="pill ${r.status === 'done' ? 'ok' : 'due'}">${r.status === 'done' ? 'submitted' : 'due'}</span></td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="empty">Nothing due in the next 7 days — clear calendar.</td></tr>`;

  const workRows = work.length
    ? work.map((r) => `
      <tr>
        <td class="course">${esc(r.course)}</td>
        <td class="item">${esc(r.title)}${r.section ? `<span class="sub">${esc(r.section)}</span>` : ''}</td>
        <td class="time">${esc(r.due || '—')}</td>
        <td class="score">${esc((r.score || '').replace('?/', '? / '))}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="empty">No open assignments.</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#313338;font-family:'gg sans','Segoe UI',system-ui,sans-serif;color:#dbdee1;padding:26px;width:1080px}
    .card{background:#2b2d31;border-radius:14px;padding:24px 26px;box-shadow:0 1px 0 rgba(0,0,0,.25)}
    .head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px}
    h1{font-size:25px;font-weight:700;color:#f2f3f5;letter-spacing:-.2px}
    .stamp{font-size:13px;color:#949ba4}
    .meta{margin:6px 0 20px;font-size:13.5px;color:#949ba4}
    .meta b{color:#dbdee1;font-weight:600}
    h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#949ba4;margin:22px 0 8px}
    table{width:100%;border-collapse:collapse;font-size:14px}
    th{text-align:left;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:#80848e;font-weight:600;padding:0 10px 7px}
    td{padding:9px 10px;border-top:1px solid #3f4147;vertical-align:top}
    td.day{white-space:nowrap;font-weight:600;color:#f2f3f5}
    td.time{white-space:nowrap;color:#b5bac1;font-variant-numeric:tabular-nums}
    td.course{color:#a3b1ff;max-width:250px}
    td.item{color:#dbdee1}
    td.score{white-space:nowrap;color:#b5bac1;font-variant-numeric:tabular-nums}
    .sub{display:block;font-size:12px;color:#949ba4;margin-top:2px}
    .pill{display:inline-block;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:999px;text-transform:lowercase}
    .pill.ok{background:rgba(35,165,90,.16);color:#3ddc84}
    .pill.due{background:rgba(240,178,50,.16);color:#f5b942}
    .empty{color:#949ba4;font-style:italic;padding:14px 10px}
    .foot{margin-top:22px;padding-top:14px;border-top:1px solid #3f4147;font-size:12px;color:#80848e;display:flex;justify-content:space-between}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#5865f2;margin-right:8px;vertical-align:middle}
  </style></head><body><div class="card">
    <div class="head"><h1>📅 eLMS · ${esc(weekLabel)}</h1><div class="stamp">${esc(generated)}</div></div>
    <div class="meta"><span class="dot"></span><b>${schedule.length}</b> dated item${schedule.length === 1 ? '' : 's'} in the next 7 days · <b>${work.length}</b> open assignment${work.length === 1 ? '' : 's'}</div>
    <h2>Next 7 days</h2>
    <table><thead><tr><th>Day</th><th>Time</th><th>Course</th><th>Item</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>Open work</h2>
    <table><thead><tr><th>Course</th><th>Assignment</th><th>Due</th><th>Score</th></tr></thead><tbody>${workRows}</tbody></table>
    <div class="foot"><span>STI eLMS · daily digest</span><span>posted by the notify bridge</span></div>
  </div></body></html>`;
}

function textTable(schedule, work) {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const lines = ['```', 'NEXT 7 DAYS'];
  if (!schedule.length) lines.push('nothing due');
  for (const r of schedule) lines.push(`${pad(r.day, 11)} ${pad(r.time || '-', 8)} ${pad(r.course, 26)} ${r.item.slice(0, 34)}`);
  lines.push('', 'OPEN WORK');
  if (!work.length) lines.push('nothing open');
  for (const r of work) lines.push(`${pad(r.course, 26)} ${pad(r.title, 30)} due ${pad(r.due || '-', 8)} ${r.score || ''}`);
  lines.push('```');
  return lines.join('\n');
}

// ---------- main ----------
(async () => {
  ensureDirs();
  const { browser, ctx, page } = await openSession();
  let digest;
  try {
    const courses = await courseList(page);
    const work = await openWork(page, courses);
    const thisWeek = await weekEvents(page, { advance: 0 });
    const nextWeek = await weekEvents(page, { advance: 1 });

    const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // YYYY-MM-DD
    const today = new Date(todayKey + 'T00:00:00Z');
    const windowEnd = new Date(today.getTime() + 7 * 86400000);

    const schedule = [];
    const seen = new Set();
    for (const wk of [thisWeek, nextWeek]) {
      for (const d of wk.days) {
        const date = dayDate(d.heading, wk.year);
        if (!date || date < today || date > windowEnd) continue;
        for (const e of d.events) {
          const key = `${date.toISOString().slice(0, 10)}|${e.time}|${e.course}|${e.item}`;
          if (seen.has(key)) continue;
          seen.add(key);
          schedule.push({
            day: fmtDate(date),
            time: e.time,
            course: e.course.replace(/\s*-\s*SY\d{4}-\dT$/, ''),
            item: e.item,
            status: e.status,
            sort: date.getTime() + minutes(e.time) * 1000,
          });
        }
      }
    }
    schedule.sort((a, b) => a.sort - b.sort);
    work.sort((a, b) => (a.due || 'zz').localeCompare(b.due || 'zz'));

    const weekLabel = `next 7 days · ${fmtDate(today)} – ${fmtDate(windowEnd)}`;

    digest = { schedule, work, weekLabel, courses: courses.length };
  } finally {
    await browser.close();
  }

  const generated = `generated ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })}`;
  const label = `eLMS · ${digest.weekLabel}`;

  if (AS_TEXT) {
    const body = `**📅 ${label}**\n${textTable(digest.schedule, digest.work)}`;
    if (DRY) { console.log(body); return; }
    const msg = await postText(body);
    console.log('posted text digest', msg && msg.id);
    return;
  }

  if (!process.argv.includes('--image')) {
    const containers = digestContainers({
      schedule: digest.schedule, work: digest.work, weekLabel: digest.weekLabel, generated,
    });
    if (DRY) { console.log(JSON.stringify(containers, null, 1)); return; }
    const msgs = await postContainers(containers);
    console.log(JSON.stringify({
      posted: msgs.map((m) => m && m.id),
      events: digest.schedule.length,
      open: digest.work.length,
      mode: 'components',
    }));
    return;
  }

  const htmlDoc = html({ weekLabel: digest.weekLabel, generated, schedule: digest.schedule, work: digest.work });
  const shotDir = path.join(cfg.root, 'digest');
  fs.mkdirSync(shotDir, { recursive: true });
  const shotPath = path.join(shotDir, `digest-${new Date().toISOString().slice(0, 10)}.png`);

  const { launch } = require('./browser');
  const renderBrowser = await launch({ headless: true });
  try {
    const p = await renderBrowser.newPage({ viewport: { width: 1080, height: 900 }, deviceScaleFactor: 2 });
    await p.setContent(htmlDoc, { waitUntil: 'load' });
    await p.screenshot({ path: shotPath, fullPage: true });
  } finally {
    await renderBrowser.close();
  }

  if (DRY) { console.log('wrote', shotPath); return; }

  const msg = await postFile(fs.readFileSync(shotPath), path.basename(shotPath), {
    title: `📅 ${label}`,
    description: `${digest.schedule.length} dated item(s) · ${digest.work.length} open assignment(s)`,
    color: 0x5865f2,
    image: { url: `attachment://${path.basename(shotPath)}` },
    footer: { text: 'STI eLMS · daily digest' },
    timestamp: new Date().toISOString(),
  });
  console.log(JSON.stringify({ posted: msg && msg.id, events: digest.schedule.length, open: digest.work.length, png: shotPath }));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
