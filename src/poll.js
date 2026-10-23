#!/usr/bin/env node
'use strict';
/**
 * One poll cycle: read the eLMS notification list, diff it against state.json, push new
 * items to Discord.
 *
 *   node src/poll.js            normal cycle (what the scheduler runs)
 *   node src/poll.js --seed     mark everything currently visible as seen, post nothing
 *   node src/poll.js --demo     post the newest notification regardless of state
 *   node src/poll.js --check    only report whether the saved session is still valid
 */
const { cfg, ensureDirs } = require('./config');
const { openSession, saveCookies } = require('./browser');
const { readNotifications, silentReauth, loadState, saveState } = require('./notifications');
const { postItems, postOne, alertOnce } = require('./discord');

const MODE = process.argv[2] || '';
const REAUTH_HINT = `eLMS session expired and the silent sign-in bounce did not restore it. Note that the LMS allows only ONE active session per account, so signing in on your phone or another browser logs the bridge out (and vice versa). Re-run \`npm run setup -- --login-only\`, or refresh ${cfg.cookiesFile}.`;

(async () => {
  ensureDirs();
  const state = loadState();
  const { browser, ctx, page } = await openSession();

  let result;
  let reauth = null;
  let cookieCount = 0;
  try {
    result = await readNotifications(page);
    if (!result.loggedIn) {
      reauth = await silentReauth(page);
      result = await readNotifications(page);
      // Neo LMS allows one session per account, so a bounce can race the previous session: retry once
      if (!result.loggedIn) {
        await page.waitForTimeout(2000);
        reauth = await silentReauth(page);
        result = await readNotifications(page);
      }
    }
    // never overwrite a good jar with the cookies of a logged-out page
    if (result.loggedIn) cookieCount = await saveCookies(ctx);
  } finally {
    await browser.close();
  }

  if (result.loggedIn && !result.tableFound) {
    console.error('no notification table on the page - not saving cookies or state, the layout may have changed');
    process.exit(4);
  }

  if (MODE === '--check') {
    console.log(JSON.stringify({ loggedIn: result.loggedIn, url: result.url, reauth: reauth && reauth.url, seen: state.seen.length }));
    process.exit(result.loggedIn ? 0 : 3);
  }

  if (!result.loggedIn) {
    await alertOnce('reauth', REAUTH_HINT);
    console.error('NOT LOGGED IN ->', result.url);
    process.exit(3);
  }

  const items = result.items;
  const seen = new Set(state.seen);
  const fresh = items.filter((i) => !seen.has(i.id)).reverse(); // oldest first

  if (MODE === '--seed') {
    state.seen = [...new Set([...items.map((i) => i.id), ...state.seen])].slice(0, cfg.keepSeen);
    state.lastPoll = new Date().toISOString();
    state.seededAt = state.lastPoll;
    saveState(state);
    console.log(`seeded ${items.length} notifications, nothing posted`);
    return;
  }

  if (MODE === '--demo') {
    if (!items.length) { console.error('no notifications on page'); process.exit(1); }
    const msg = await postOne(items[0]);
    console.log('demo post id', msg && msg.id);
    state.seen = [...new Set([...items.map((i) => i.id), ...state.seen])].slice(0, cfg.keepSeen);
    state.lastPoll = new Date().toISOString();
    saveState(state);
    return;
  }

  const budget = fresh.slice(0, cfg.maxPostsPerCycle);
  await postItems(budget);
  const posted = budget.length;

  state.seen = [...new Set([...items.map((i) => i.id), ...state.seen])].slice(0, cfg.keepSeen);
  state.lastPoll = new Date().toISOString();
  state.alertHash = null;
  saveState(state);

  console.log(JSON.stringify({
    scanned: items.length,
    new: fresh.length,
    posted,
    skipped: Math.max(0, fresh.length - posted),
    at: state.lastPoll,
  }));
})().catch(async (e) => {
  const transient = /timeout|net::|ECONN|EAI_AGAIN|EPIPE|load failed/i.test(e.message || '');
  console.error('ERR', e.message);
  // transient network/timeout failures self-heal on the next 10-minute cycle - no Discord noise
  if (!transient) {
    try { await alertOnce('error', `eLMS bridge error: ${e.message}`); } catch { }
  }
  process.exit(1);
});
