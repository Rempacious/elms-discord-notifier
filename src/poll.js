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
const { post, embedFor, alertOnce } = require('./discord');

const MODE = process.argv[2] || '';
const REAUTH_HINT = `eLMS session expired and the silent sign-in bounce did not restore it. Sign in once in a browser, then re-run \`npm run setup -- --login-only\` (or copy the fresh cookies into ${cfg.cookiesFile}).`;

(async () => {
  ensureDirs();
  const state = loadState();
  const { browser, ctx, page } = await openSession();

  let result;
  let reauth = null;
  try {
    result = await readNotifications(page);
    if (!result.loggedIn) {
      reauth = await silentReauth(page);
      result = await readNotifications(page);
    }
  } finally {
    try { await saveCookies(ctx); } catch { }
    await browser.close();
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
    const msg = await post({ embeds: [embedFor(items[0])] });
    console.log('demo post id', msg && msg.id);
    state.seen = [...new Set([...items.map((i) => i.id), ...state.seen])].slice(0, cfg.keepSeen);
    state.lastPoll = new Date().toISOString();
    saveState(state);
    return;
  }

  const budget = fresh.slice(0, cfg.maxPostsPerCycle);
  let posted = 0;
  for (let i = 0; i < budget.length; i += cfg.batchSize) {
    const chunk = budget.slice(i, i + cfg.batchSize);
    await post({ embeds: chunk.map(embedFor) });
    posted += chunk.length;
  }

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
  console.error('ERR', e.message);
  try { await alertOnce('error', `eLMS bridge error: ${e.message}`); } catch { }
  process.exit(1);
});
