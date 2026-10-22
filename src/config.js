'use strict';
/**
 * Shared configuration and paths.
 *
 * Everything is read from an optional `.env` next to package.json, falling back to
 * sensible defaults, so the same code runs for any Neo LMS (CYPHER Learning)
 * instance, not just one school.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* no .env yet - setup.js creates one */ }
  return out;
}

const ENV = loadEnv();
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const cfg = {
  root: ROOT,
  dataDir: DATA,
  baseUrl: (ENV.ELMS_BASE_URL || 'https://elms.sti.edu').replace(/\/+$/, ''),
  webhook: ENV.DISCORD_WEBHOOK_URL || '',
  threadId: ENV.DISCORD_THREAD_ID || '',
  pollMinutes: num(ENV.POLL_MINUTES, 10),
  maxPostsPerCycle: num(ENV.MAX_POSTS_PER_CYCLE, 8),
  batchSize: num(ENV.DISCORD_BATCH_SIZE, 5),
  keepSeen: num(ENV.SEEN_HISTORY, 800),
  timeoutMs: num(ENV.PAGE_TIMEOUT_MS, 60000),
  headless: ENV.HEADLESS !== 'false',
  cookiesFile: path.join(DATA, 'cookies.json'),
  stateFile: path.join(DATA, 'state.json'),
  logFile: path.join(ROOT, 'logs', 'poll.log'),
  env: ENV,
};

function ensureDirs() {
  for (const d of [cfg.dataDir, path.dirname(cfg.logFile)]) fs.mkdirSync(d, { recursive: true });
}

module.exports = { cfg, ensureDirs, ROOT };
