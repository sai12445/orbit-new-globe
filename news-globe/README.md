# ORBIT — live world events map

A real-time world map of global events with **country → state drill-down** and
**AI impact briefs written by Groq**. The Groq API key lives only on the server,
never in the browser.

## What it does

- **Live data, no key needed:**
  - **News outlets via RSS** — BBC, Times of India, The Hindu, NDTV, Al Jazeera, The Guardian,
    Firstpost, Hindustan Times, Indian Express — across world, India, business, tech, sports.
    Headlines are de-duplicated, summarised, and (where a place is detected) pinned on the globe.
  - **USGS** — every M4.5+ earthquake in the last week, precise coordinates (authoritative).
- **Drill-down:** click a country to zoom in and see its states/provinces, click a state
  to zoom further. Each region is shaded by how many events it contains (a live "counter map").
- **AI briefs:** click any event → the server asks **Groq** to write a short impact brief
  (summary, why it matters, who's affected, confidence). Cached per event.
- Auto-refreshes every 5 minutes.

## Setup (3 steps)

1. **Install** (needs Node 18+):
   ```bash
   npm install
   ```
2. **Add your Groq key.** Copy the example env file and paste your key
   (get one free at https://console.groq.com/keys):
   ```bash
   cp .env.example .env
   # then edit .env and set GROQ_API_KEY=...
   ```
3. **Run:**
   ```bash
   npm start
   ```
   Open **http://localhost:3000**.

That's it. The map and live events work even without a Groq key; the key is only
needed for the AI briefs.

## How it's wired (the architecture you asked about)

```
browser (map)  ──►  YOUR server (server.js)  ──►  RSS outlets + USGS (no key)
                                              └─►  Groq API       (key stays here)
```

The browser only ever talks to your own server. Secret keys (Groq, and any paid
APIs you add later) stay server-side. This is the standard, safe pattern.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/events` | Live events (RSS outlets + USGS), geolocated + tagged with country/state |
| GET | `/api/geo/countries` | World country boundaries (GeoJSON) |
| GET | `/api/geo/states/:iso` | States/provinces for one country (e.g. `/api/geo/states/IN`) |
| POST | `/api/brief` | Groq-written brief for one event (`{ "event": {...} }`) |
| GET | `/api/health` | Status (is the Groq key set, are boundaries loaded) |

## Adding more real-time sources

Add a `fetchX()` in `server.js` like `fetchUSGS`, push its results into `getEvents()`,
and they'll appear on the map automatically. For any source that needs a secret key
(stock indices, premium news, weather alerts), call it from `server.js` with the key
from `process.env` — exactly like the Groq call — so the key never reaches the browser.

## Config

| Env var | Default | Notes |
|---|---|---|
| `GROQ_API_KEY` | — | Required for AI briefs |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Try `llama-3.1-8b-instant` for speed/cost |
| `PORT` | `3000` | |

## Notes & limits

- Country/state shapes come from Natural Earth (loaded once at startup). The first
  boot fetches them over the network.
- GDELT geolocation is breadth-first and noisy; USGS quakes are exact. Always link
  back to the original source before relying on a single report.
- Free Groq and free data tiers have rate limits; briefs are cached per event to help.

## Deploy

Any Node host works (Render, Railway, Fly.io, a VPS). Set the env vars in the host's
dashboard, deploy, done. For serverless (Vercel/Netlify), move each route into a
function and keep `GROQ_API_KEY` as a project secret.

## Troubleshooting

**Blank page that says "Connecting to live feeds…" with console errors about
`sw.js`, `THREE is not defined`, or Content Security Policy.**
This happens when a *different* app previously ran on the same `localhost` port and
registered a service worker / CSP that hijacks this page. Fixes (this build already
does the first two for you):

1. three.js is bundled locally (`public/vendor/three.min.js`) — no CDN, so CSP can't block it.
2. `index.html` auto-unregisters leftover service workers and clears caches on load,
   then reloads once.
3. If it's still stuck, clear it manually in the browser:
   **DevTools → Application → Service workers → Unregister**, then
   **Application → Storage → Clear site data**, then hard-reload (Ctrl/Cmd-Shift-R).
   Or just run the app on a different port (set `PORT=3222` in `.env`).

**Run it from the right folder.** The zip unpacks to a folder named `news-globe`.
Make sure `cat package.json | grep '"name"'` says `orbit-news-globe`, not some other
app, before `npm start`.
