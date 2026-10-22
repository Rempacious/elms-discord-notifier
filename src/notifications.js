'use strict';
/**
 * Reading the notification list out of a Neo LMS page, and the silent SSO re-auth bounce.
 *
 * Row shape (stable across Neo LMS builds we have seen):
 *   <tr>
 *     <td><input name="select[]" value="<id>"></td>
 *     <td><a href="/user/show/<uid>">Sender</a></td>
 *     <td><a role="button" href="/notifications/show?notification=<id>">Subject</a></td>
 *     <td class="hideCell">1:39 am</td>
 *     <td>...<i class="tick"> = read ...</td>
 *   </tr>
 */
const fs = require('fs');
const { cfg } = require('./config');

async function readNotifications(page) {
  await page.goto(cfg.baseUrl + '/notifications', { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
  await page.waitForTimeout(1500);
  const url = page.url();
  if (/log_in|not_logged_in/.test(url)) return { loggedIn: false, url, items: [] };

  const items = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href^="/notifications/show?notification="]')) {
      const m = a.getAttribute('href').match(/notification=(\d+)/);
      if (!m) continue;
      const tr = a.closest('tr');
      const fromA = tr && tr.querySelector('td a[href^="/user/show/"]');
      const tds = tr ? Array.from(tr.querySelectorAll('td')) : [];
      out.push({
        id: m[1],
        subject: a.textContent.trim().replace(/\s+/g, ' '),
        from: fromA ? fromA.textContent.trim() : '',
        time: tds.length >= 2 ? tds[tds.length - 2].innerText.trim().replace(/\s+/g, ' ') : '',
        read: !!(tr && tr.querySelector('.tick')),
      });
    }
    return out;
  });
  return { loggedIn: true, url, items };
}

/**
 * Walk the SSO bounce using cookies we already hold (Entra/Google/Microsoft), which is
 * silent while the identity-provider cookie is alive. Returns the URL we ended on.
 */
async function silentReauth(page) {
  await page.goto(cfg.baseUrl + '/log_in/form', { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
  const clicked = await page.evaluate(() => {
    const form = document.querySelector('form#sso');
    const btn = document.querySelector('#office365_sso_btn, #google_sso_btn, .sso_btn');
    const href = btn && btn.getAttribute('href');
    if (href) { window.location.href = href; return href; }
    if (form) { form.action = form.getAttribute('action') || '/auth/microsoft_office365'; form.method = 'post'; form.submit(); return form.action; }
    return null;
  }).catch(() => null);
  await page.waitForTimeout(9000);
  return { clicked, url: page.url() };
}

// ---------- state ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); }
  catch { return { seen: [], lastPoll: null, alertHash: null }; }
}

function saveState(state) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(cfg.stateFile, JSON.stringify(state, null, 1));
}

module.exports = { readNotifications, silentReauth, loadState, saveState };
