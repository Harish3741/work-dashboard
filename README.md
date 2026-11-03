# Work Dashboard

A local-first calendar, to-do board and habit tracker you run on your own
machine. It ships blank and connected to nothing: no accounts, no cloud, no
API keys. Add your own calendars and plug in other sources as you need them.

## What's in it

| Page | What it does |
| --- | --- |
| **Today** (`/`) | A to-do board running from last week to next week. Each day mixes events from your calendars with tasks you type in. The **Need to action** list in the sidebar holds undated to-dos. |
| **Dashboard** (`/dashboard`) | A tabbed space for longer-running work. It ships with **Contacts** (add people by hand or bulk-import them). Add your own tabs in `src/components/dashboard/DashboardView.tsx`. |
| **Streaks** (`/streaks`) | A habit × week grid for the year. |
| **Calendar** (`/calendar`) | Month and week views of every connected calendar plus events you add here. |

Double-click any row for a notes panel. Lines starting with `- [ ] ` become
tick-boxes.

## Setup

```bash
npm install
npm run dev        # http://127.0.0.1:4321
```

Data lives in `data/habits.db` (SQLite, gitignored). Set `HABIT_DATA_DIR` to
keep it somewhere else.

For an always-on copy, run `npm run build` once, then `npm start`.

## Connecting calendars

Calendars are read from **ICS feed URLs** and are never written to.

- **Google Calendar:** Settings → your calendar → *Integrate calendar* → *Secret address in iCal format*.
- **Outlook / Microsoft 365:** Settings → Calendar → *Shared calendars* → *Publish a calendar* → copy the ICS link.
- **Apple Calendar:** right-click a calendar → *Share Calendar* → tick *Public Calendar* → copy the link.

Paste the link into the sidebar's **Calendars → Manage**. You can also put it
in `.env.local` as `CALENDAR_<NAME>_URL` (see `.env.example`). Feeds refresh
every hour and whenever you press **Refresh**.

> Feed URLs let anyone holding them read that calendar, so treat them like
> passwords. `.env.local` and `data/` are gitignored. Keep them out of commits.

## How habits work

- A habit matches events by title (`Gym`, or "contains" `standup`), optionally
  limited to one calendar.
- Ticking a matching event is what moves a habit along. Ticking any other event
  just marks it done.
- Goal types: **times per week** (every tick counts), **days per week**
  (distinct days) or **every day**.
- Weeks run Monday to Sunday. Dates show in `APP_TZ` (default
  `Australia/Sydney`; set your own in `.env.local`).

## Adding your own sources

Everything goes through plain JSON routes under `src/app/api/`, so a script, a
cron job or another app can write to the dashboard:

| Route | Use |
| --- | --- |
| `POST /api/tasks` `{ title, ymd, startMin? }` | add a to-do to a day |
| `POST /api/actions` `{ title }` | add to *Need to action* |
| `POST /api/events` `{ title, ymd, startMin?, endMin? }` | add a local event |
| `POST /api/contacts` `{ name, role?, org?, email?, … }` or `{ contacts: [...] }` | add or bulk-import contacts |
| `POST /api/notes` `{ key, body }` | set the notes on an item |
| `GET /api/state` | everything the Today page shows |

Open pages refresh by themselves within a few seconds of any write
(`src/lib/changes.ts`). To pull from a new source on a timer, add it next to
the calendar refresh in `src/lib/sync.ts`, then add a `call(...)` for it in
`runSync` (`src/components/useAppState.ts`) so **Refresh** runs it too.

## Development

```bash
npm run dev      # dev server (HOST / PORT override 127.0.0.1:4321)
npm run build    # production build
npm test         # compiles src/lib with tsc, then runs the node tests
```

`src/lib` has no Next-specific imports and uses NodeNext `.js` specifiers, so
it compiles and tests with plain `tsc`. `next.config.ts` maps those
specifiers back to the TypeScript sources for the bundler.

The server binds to `127.0.0.1`, so only this machine can reach it.
