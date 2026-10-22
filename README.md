# eLMS → Discord Notifier

Forward **Neo LMS / CYPHER Learning** notifications (STI eLMS, and any other Neo-based campus LMS) into a Discord channel — graded work, "due soon" reminders, announcements, points awarded, messages — as rich embeds that link straight back to the item.

No API key, no admin help, no email forwarding needed. It drives the website the same way your browser does, on a schedule, and only posts what is **new** since the last check.

```
╭───────────────────────────────────────────────╮
│ ⏰ Due soon                                    │
│ ### 05 Quiz 1 - ARG                           │
│ -# 📚 Computer Graphics Programming - SY2627-1T│
│ ─────────────────────────────────────────────  │
│ Michael John Siquihod  ·  19 hours ago        │
│ [ Open in eLMS ]                              │
╰───────────────────────────────────────────────╯
```

Messages use Discord's **Components V2** layout: a container with a coloured accent bar per
notification type, a markdown heading, course subtext, `<t:…>` timestamps that render in each
reader's own timezone, and a link button back into the item. If the target API/client rejects the
V2 payload, it degrades to classic rich embeds automatically and remembers that choice.

---

## Requirements

- **Node.js 20+**
- A Discord channel you can add a webhook to
- An eLMS account (password or SSO — both work)

## Quick start

```bash
git clone https://github.com/Rempacious/elms-discord-notifier.git
cd elms-discord-notifier
npm install
npm run setup
```

That is the whole installation. `npm run setup` walks through four steps:

1. **Discord webhook** — asks for the URL and posts a test message so you know it works.
2. **Sign-in** — opens a real browser window pointed at the LMS login page. Sign in however you normally do (school SSO, Microsoft/Google, password). The script waits, detects the logged-in page, and saves the session cookies to `data/cookies.json`. **Your password is never typed into this tool — you type it into the browser.**
3. **Seeding** — records the notifications already on the page so your channel does not get 30 messages at once.
4. **Scheduler** — registers a Windows Scheduled Task (or prints the cron line on Linux/macOS) to poll every 10 minutes.

Then:

```bash
npm start        # run one cycle by hand
npm run demo     # post the newest notification right now, as a test
```

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Full wizard (config → Discord test → browser sign-in → seed → scheduler) |
| `npm run setup -- --login-only` | Only refresh the saved browser session (after a password change or session expiry) |
| `npm start` | One poll cycle: fetch → diff → post new items |
| `npm run seed` | Mark everything currently visible as seen, post nothing |
| `npm run demo` | Post the newest notification regardless of state |
| `npm run check` | Report whether the saved session is still logged in |
| `npm run snapshot` | Dump page HTML into `snapshots/` (for troubleshooting parser changes) |
| `npm run digest` | Post the daily schedule digest (rendered table image) |
| `npm run digest:preview` | Build the digest image locally without posting (`./digest/`) |

## Configuration (`​.env`)

| Key | Default | Meaning |
|---|---|---|
| `ELMS_BASE_URL` | `https://elms.sti.edu` | Any Neo LMS / CYPHER Learning site |
| `DISCORD_WEBHOOK_URL` | — | Channel webhook (required) |
| `DISCORD_THREAD_ID` | — | Post inside a thread instead of the channel |
| `POLL_MINUTES` | `10` | Cadence; match it in the scheduler entry |
| `MAX_POSTS_PER_CYCLE` | `8` | Upper bound on messages per run (burst protection) |
| `DISCORD_BATCH_SIZE` | `5` | Embeds per Discord message (10 max) |
| `SEEN_HISTORY` | `800` | Notification IDs remembered for de-duplication |
| `HEADLESS` | `true` | `false` shows the browser while polling |

## Scheduling

**Windows** (done for you by the wizard, or manually):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1          # every POLL_MINUTES
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Minutes 5
```

The task runs `run-poll.cmd`, which logs to `logs/poll.log` (rotated at 2 MB). Registering as `SYSTEM` keeps it running with nobody logged in; the script falls back to the current user if it lacks elevation.

**Linux / macOS**

```bash
chmod +x scripts/run-poll.sh
crontab -e
*/10 * * * * /usr/bin/env bash /path/to/elms-discord-notifier/scripts/run-poll.sh
```

## Daily schedule digest

`npm run digest` posts a **native, mobile-first** digest — Components V2 cards that wrap and scale
on a phone, with nothing to pinch-zoom:

- **Next 7 days** — day · time · status (`✅ submitted` / `⏳ not submitted`), then course and item
- **Open work** — course · due date · score, then the assignment and its section
- A button straight to your eLMS calendar

It reads the calendar agenda for the current *and* next week, filters to a rolling 7-day window, then
pulls each course's unsubmitted list. Administrative surveys are skipped.

Variants:

```bash
npm run digest                       # native cards (default, best on mobile)
npm run digest -- --image            # rendered PNG table (desktop-friendly, ./digest/)
npm run digest -- --text             # monospace code-block table (copy/paste-able)
npm run digest:preview               # print the payload without posting
```

Register it as a daily task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-digest-task.ps1          # 07:00 daily
powershell -ExecutionPolicy Bypass -File scripts\install-digest-task.ps1 -At 06:30
```

```bash
# Linux/macOS
0 7 * * * /usr/bin/env bash /path/to/elms-discord-notifier/scripts/run-digest.sh
```

## How it works

- **Platform**: the target is Neo LMS (CYPHER Learning). Its REST API (`/api/v1`, `/api/v3`) requires an admin-installed app and an API key, so a student account cannot use it — this tool scrapes the notification list instead.
- **Auth**: `data/cookies.json` holds the LMS session **and** the identity-provider cookies (Microsoft/Entra, Google, …). Those cookies let the poller renew an expired LMS session silently, with no password and no browser window.
- **Reading**: `GET /notifications`, parse each table row (id, sender, subject, timestamp, read flag). New IDs are diffed against `data/state.json`.
- **Posting**: embeds batched 5 per message, colour and emoji by type (⏰ due-soon, 📝 graded, 🏆 points/badges, 💬 messages, 📢 announcements), each linking to `/notifications/show?notification=<id>`.
- **Why Playwright**: replaying the cookies through `fetch` gets a `302 → /site/not_logged_in`; the same cookies inside a real browser context are logged in. The tool uses `playwright-core` and reuses any Chromium already on the machine (Playwright's cache, Chrome, Edge, Chromium). If none is found: `npx playwright-core install chromium`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NOT LOGGED IN` / ⚠️ alert in Discord | `npm run setup -- --login-only` and sign in again |
| Discord test message fails | Webhook deleted or wrong channel — create a new one |
| `discord 429` | You are polling too often; raise `POLL_MINUTES` |
| Task shows `Ready` but nothing posts | `tail -20 logs/poll.log`; check `npm run check` |
| Nothing detected after a site redesign | `npm run snapshot` and compare the notification row markup with `src/notifications.js` |
| Chromium missing | `npx playwright-core install chromium`, or set `CHROME_PATH` |

## Limits and fair use

- Page 1 of the notification list is read (newest ~30). If more than that arrive between two runs, the oldest of that burst can be missed — 10 minutes is deliberately conservative.
- **The LMS allows one session per account.** Signing in on your phone or another browser kicks the bridge out, and the bridge signing back in kicks that browser out. The bridge re-authenticates silently on the next cycle, so it self-heals — but if you are actively using eLMS in a browser you will both see "logged out" notices. Do not run two copies of this tool against one account.
- It never marks anything read in the LMS; posting does not touch your account state.
- This is an unofficial client. Keep the interval sane (the site rate-limits and will return HTTP 429), do not share your `data/cookies.json` (it is a live session), and check your institution's acceptable-use policy before running automated tooling against a school system.

## Privacy

`.env`, `data/` and `logs/` are git-ignored. The only things that leave your machine are the notification embeds posted to the Discord webhook you configure.

## License

MIT — see [LICENSE](LICENSE).
