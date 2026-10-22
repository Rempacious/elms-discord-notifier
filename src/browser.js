'use strict';
/**
 * Browser plumbing: locate a Chromium, open a context seeded with saved cookies,
 * and check whether that session is still logged in.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');
const { cfg } = require('./config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Find a usable Chromium without forcing users through `npx playwright install`. */
function chromiumPath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  // a scheduler that runs as another account (SYSTEM, another user) needs the path written down
  try {
    const pinned = fs.readFileSync(path.join(cfg.root, '.browser-path'), 'utf8').trim();
    if (pinned && fs.existsSync(pinned)) return pinned;
  } catch { /* optional file */ }

  const local = process.env.LOCALAPPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local') : '');
  const roots = [
    local && path.join(local, 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);

  // Windows: when running as SYSTEM the browsers live under another user's profile
  if (process.platform === 'win32') {
    try {
      for (const user of fs.readdirSync('C:\\Users')) {
        roots.push(path.join('C:\\Users', user, 'AppData', 'Local', 'ms-playwright'));
      }
    } catch { /* not readable */ }
  }

  const found = [];
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      if (!/^chromium-\d+$/.test(d)) continue;
      found.push(path.join(root, d, 'chrome-win64', 'chrome.exe'));
      found.push(path.join(root, d, 'chrome-linux', 'chrome'));
      found.push(path.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
    if (found.some((p) => fs.existsSync(p))) break;
  }

  // last resort: a system Chrome/Edge (Edge misbehaves under SYSTEM, but is fine for normal users)
  found.push(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  const ok = found.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
  return ok[0] || null; // null => let playwright resolve its own bundled build
}

async function launch({ headless = cfg.headless } = {}) {
  const executablePath = chromiumPath();
  const opts = {
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  };
  if (executablePath) opts.executablePath = executablePath;
  return chromium.launch(opts);
}

function loadCookies() {
  try {
    const list = JSON.parse(fs.readFileSync(cfg.cookiesFile, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function newContext(browser) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 }, locale: 'en-US' });
  const cookies = loadCookies();
  if (cookies.length) {
    try { await ctx.addCookies(cookies); } catch (e) { console.error('cookie load failed:', e.message); }
  }
  return ctx;
}

async function saveCookies(ctx) {
  const all = await ctx.cookies();
  fs.mkdirSync(path.dirname(cfg.cookiesFile), { recursive: true });
  fs.writeFileSync(cfg.cookiesFile, JSON.stringify(all, null, 1));
  return all.length;
}

const isLoginUrl = (url) => /log_in|not_logged_in|simultaneous_logins|warning\/|login\.microsoftonline|accounts\.google/i.test(url || '');

/** Open a context + page and report whether the stored session still works. */
async function openSession({ headless = cfg.headless } = {}) {
  const browser = await launch({ headless });
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

async function sessionState(page) {
  await page.goto(cfg.baseUrl + '/notifications', { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs }).catch(() => { });
  await page.waitForTimeout(1200);
  const url = page.url();
  const title = await page.title().catch(() => '');
  return { url, title, loggedIn: !isLoginUrl(url) };
}

module.exports = { launch, openSession, newContext, saveCookies, loadCookies, sessionState, chromiumPath, isLoginUrl, UA };

// debug helper:  node src/browser.js --print
if (require.main === module) console.log(chromiumPath() || '(none found - playwright will resolve its bundled build)');

