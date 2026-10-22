#!/usr/bin/env node
'use strict';
/**
 * Session tools for debugging.
 *
 *   node src/session.js --check     is the stored cookie jar still logged in?
 *   node src/session.js --login     open a visible browser, wait for you to sign in, save cookies
 *   node src/session.js --snapshot  dump the HTML of the main pages into ./snapshots
 *   node src/session.js --whoami    print the account name the session belongs to
 */
const fs = require('fs');
const path = require('path');
const { cfg } = require('./config');
const { openSession, saveCookies, sessionState } = require('./browser');

const MODE = process.argv[2] || '--check';

(async () => {
  if (MODE === '--login') {
    const { browser, ctx, page } = await openSession({ headless: false });
    await page.goto(cfg.baseUrl + '/log_in/form', { waitUntil: 'domcontentloaded' });
    console.log('Sign in in the browser window. Waiting up to 5 minutes...');
    const ok = await page
      .waitForFunction(() => !/log_in|not_logged_in|microsoftonline|accounts\.google/.test(location.href), null, { timeout: 300000 })
      .then(() => true)
      .catch(() => false);
    console.log(ok ? 'signed in: ' + page.url() : 'timed out');
    console.log('cookies saved:', await saveCookies(ctx));
    await browser.close();
    process.exit(ok ? 0 : 1);
  }

  const { browser, ctx, page } = await openSession();
  const st = await sessionState(page);

  if (MODE === '--whoami' && st.loggedIn) {
    await page.goto(cfg.baseUrl + '/user_dashboard', { waitUntil: 'domcontentloaded' }).catch(() => { });
    const name = await page.title().catch(() => '');
    console.log(name);
  }

  if (MODE === '--snapshot' && st.loggedIn) {
    const dir = path.join(cfg.root, 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    for (const p of ['user_dashboard', 'notifications', 'home_news', 'inbox']) {
      const res = await page.goto(`${cfg.baseUrl}/${p}`, { waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.waitForTimeout(900);
      const html = await page.content();
      fs.writeFileSync(path.join(dir, `${p}.html`), html);
      console.log(`${p}: ${res ? res.status() : 0} ${html.length}b`);
    }
  }

  await saveCookies(ctx);
  await browser.close();
  console.log(JSON.stringify(st));
  process.exit(st.loggedIn ? 0 : 3);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
