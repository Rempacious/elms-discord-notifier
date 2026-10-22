#!/usr/bin/env node
'use strict';
/**
 * Interactive installer.
 *
 *   npm run setup                  full wizard: config -> Discord test -> browser sign-in -> seed -> scheduler
 *   npm run setup -- --login-only  only refresh the saved browser session
 *   npm run setup -- --yes         accept defaults, no prompts (values may come from env)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');
const { ROOT, cfg } = require('./config');

const args = process.argv.slice(2);
const YES = args.includes('--yes') || args.includes('-y');
const LOGIN_ONLY = args.includes('--login-only');
const DEFAULT_BASE = 'https://elms.sti.edu';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function readEnvFile() {
  try {
    const out = {};
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch { return {}; }
}

function writeEnvFile(values) {
  const lines = [
    '# eLMS -> Discord bridge configuration',
    `ELMS_BASE_URL=${values.ELMS_BASE_URL}`,
    `DISCORD_WEBHOOK_URL=${values.DISCORD_WEBHOOK_URL}`,
    `DISCORD_THREAD_ID=${values.DISCORD_THREAD_ID || ''}`,
    `POLL_MINUTES=${values.POLL_MINUTES || 10}`,
    `MAX_POSTS_PER_CYCLE=${values.MAX_POSTS_PER_CYCLE || 8}`,
    'DISCORD_BATCH_SIZE=5',
    'SEEN_HISTORY=800',
    '# HEADLESS=false  # uncomment to watch the poller work',
    '',
  ];
  fs.writeFileSync(path.join(ROOT, '.env'), lines.join('\n'));
  console.log(green(`wrote ${path.join(ROOT, '.env')}`));
}

async function prompt(rl, question, def) {
  if (YES) return def;
  const suffix = def ? dim(` [${def}]`) : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || def || '';
}

async function main() {
  console.log(bold('\neLMS -> Discord notification bridge - setup\n'));
  const previous = readEnvFile();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 1. browser sign-in (works on its own for re-auth)
  const { openSession, saveCookies } = require('./browser');

  let baseUrl = previous.ELMS_BASE_URL || DEFAULT_BASE;
  let webhook = previous.DISCORD_WEBHOOK_URL || '';
  let threadId = previous.DISCORD_THREAD_ID || '';

  if (!LOGIN_ONLY) {
    baseUrl = (await prompt(rl, 'eLMS base URL', baseUrl)).replace(/\/+$/, '');
    webhook = await prompt(rl, 'Discord webhook URL (Server Settings > Integrations > Webhooks)', webhook);
    threadId = await prompt(rl, 'Post into a thread? paste thread ID (blank = channel)', threadId);
    const mins = await prompt(rl, 'Check every N minutes', String(previous.POLL_MINUTES || 10));

    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(webhook)) {
      console.log(red('That does not look like a Discord webhook URL. Aborting.'));
      rl.close();
      process.exit(1);
    }

    writeEnvFile({ ELMS_BASE_URL: baseUrl, DISCORD_WEBHOOK_URL: webhook, DISCORD_THREAD_ID: threadId, POLL_MINUTES: mins });
  } else {
    baseUrl = previous.ELMS_BASE_URL || DEFAULT_BASE;
    console.log(dim(`using ${baseUrl}`));
  }

  // 2. Discord reachability
  if (webhook) {
    process.env.DISCORD_WEBHOOK_URL = webhook;
    process.env.DISCORD_THREAD_ID = threadId;
    process.env.ELMS_BASE_URL = baseUrl;
    const q = new URLSearchParams({ wait: 'true' });
    if (threadId) q.set('thread_id', threadId);
    try {
      const res = await fetch(`${webhook}?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({
          embeds: [{ title: '\ud83d\udd14 eLMS bridge installed', description: `Watching \`${baseUrl}/notifications\`.`, color: 5793266 }],
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      console.log(green('Discord test message delivered - check the channel.'));
    } catch (e) {
      console.log(red(`Discord test failed: ${e.message}`));
      rl.close();
      process.exit(1);
    }
  }

  // 3. sign in and capture cookies
  console.log(bold('\nOpening a browser to capture your eLMS session.'));
  console.log(dim('Sign in exactly the way you normally do (password or SSO). The window closes itself.'));
  const { browser, ctx, page } = await openSession({ headless: false });
  await page.goto(baseUrl + '/log_in/form', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { });
  const ok = await page
    .waitForFunction(() => !/log_in|not_logged_in|microsoftonline|accounts\.google|okta|saml/i.test(location.href), null, { timeout: 300000 })
    .then(() => true)
    .catch(() => false);
  const n = await saveCookies(ctx);
  await browser.close();
  if (!ok) {
    console.log(red('Sign-in was not detected. Re-run `npm run setup -- --login-only` and try again.'));
    rl.close();
    process.exit(1);
  }
  console.log(green(`session captured (${n} cookies) -> data/cookies.json`));

  if (LOGIN_ONLY) { rl.close(); return; }

  // 4. seed state so the channel is not flooded with old notifications
  const { spawnSync: run } = require('child_process');
  console.log(bold('\nSeeding seen-state'));
  const seed = run(process.execPath, [path.join(__dirname, 'poll.js'), '--seed'], { stdio: 'inherit', env: process.env });
  if (seed.status !== 0) console.log(yellow('seeding failed - first real poll may post the current page, that is harmless'));

  // 5. scheduler
  const install = (await prompt(rl, `Install the ${process.platform === 'win32' ? 'Windows scheduled task' : 'cron job'} (every ${previous.POLL_MINUTES || 10} min)? (y/n)`, 'y')).toLowerCase();
  if (install.startsWith('y')) {
    if (process.platform === 'win32') {
      const ps = path.join(ROOT, 'scripts', 'install-task.ps1');
      const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { stdio: 'inherit' });
      if (r.status !== 0) console.log(yellow('scheduler install failed - see scripts/install-task.ps1 to run it manually'));
    } else {
      const script = path.join(ROOT, 'scripts', 'run-poll.sh');
      console.log(`\nAdd this to crontab -e:\n\n*/${previous.POLL_MINUTES || 10} * * * * ${process.execPath} ${path.join(__dirname, 'poll.js')} >> ${path.join(ROOT, 'logs', 'poll.log')} 2>&1\n`);
      console.log(dim(`(helper: ${script})`));
    }
  }

  rl.close();
  console.log(bold(green('\nDone. ')) + 'Try `npm start` to run one cycle, `npm run demo` to post the newest notification.\n');
}

main().catch((e) => { console.error(red('setup failed: ' + e.message)); process.exit(1); });
