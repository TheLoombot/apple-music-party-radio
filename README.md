# Apple Music Party Radio

A real-time collaborative radio station app built on Apple Music. One person owns a station; anyone with the link can tune in, add tracks to the shared queue, and hear the same song at the same moment. A Robot DJ automatically fills the queue from the station's pool of previously-played tracks when humans go quiet.

---

## Architecture

```
apple-music-party-radio/
├── client/          # React + Vite frontend (TypeScript)
│   └── src/
│       ├── components/   # UI: NowPlaying, UpNext, StationList, AddTracks, …
│       ├── services/
│       │   ├── appleMusic.ts   # Apple Music REST API calls
│       │   ├── musickit.ts     # MusicKit JS wrapper (auth, playback)
│       │   ├── partykit.ts     # WebSocket client (station + index rooms)
│       │   └── playbackLoop.ts # Tracks expiration times, drives MusicKit playback
│       └── types.ts
├── party/
│   └── index.ts     # PartyKit server (Cloudflare Durable Objects)
├── scripts/
│   └── generate-token.mjs   # Generates Apple Music developer JWT
└── partykit.json
```

### How it works

**Synchronisation** is time-based, not stream-based. Each track in the queue carries an `expirationTime` (Unix ms). Every connected client independently calculates how far through the current track they should be and seeks MusicKit to that position. No audio is streamed — every listener plays the track from their own Apple Music subscription in perfect sync.

**State** lives entirely in PartyKit (Cloudflare Durable Objects). Two room types:

| Room | Purpose |
|------|---------|
| `index` | Maintains the registry of all active stations, broadcasts to the station-list UI |
| `{userId}` | Owns the queue, pool, and all playback events for one station |

**Robot DJ** runs server-side. When the queue is empty or the last robot-queued track starts playing with nothing behind it, the server picks a random track from the station's pool (previously-played songs) and queues it automatically.

**Playback loop** (`playbackLoop.ts`) runs client-side. It watches the queue, sets MusicKit's queue to the current track, seeks to the correct offset, and sends an `expire_track` message to the server when a track's `expirationTime` passes.

---

## Local development

### Prerequisites

- Node.js 18+
- An Apple Developer account with an active [Apple Music API key](https://developer.apple.com/documentation/applemusicapi/generating_developer_tokens)
  - Team ID (10-char string, top-right of the developer portal)
  - Key ID (shown when you create or view the key)
  - Downloaded `.p8` private key file

### 1. Install dependencies

```bash
npm run install:all
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_KEY_ID=XXXXXXXXXX
APPLE_PRIVATE_KEY_PATH=./AuthKey_XXXXXXXXXX.p8
```

Place your `.p8` file in the project root (it is gitignored via `*.p8`).

### 3. Generate an Apple Music developer token

```bash
npm run generate-token
```

Copy the printed JWT into `.env` as `VITE_APPLE_DEVELOPER_TOKEN`. It is valid for 180 days.

### 4. Run everything

```bash
npm run dev
```

This starts both servers concurrently:

| Process | URL |
|---------|-----|
| PartyKit (Durable Objects, local) | `http://localhost:1999` |
| Vite dev server (React app) | `http://localhost:5173` |

Open `http://localhost:5173`. The app will ask you to connect your Apple Music account on first load.

> **Note:** The app uses `import.meta.env.DEV` to automatically point the WebSocket client at `localhost:1999` during development.

---

## Production deployment

### Client (static site)

Build the client:

```bash
npm run build
```

The output is in `client/dist/` — a standard static site you can host anywhere: Cloudflare Pages, Vercel, Netlify, S3 + CloudFront, etc.

Set the following environment variable in your hosting provider:

| Variable | Value |
|----------|-------|
| `VITE_APPLE_DEVELOPER_TOKEN` | Your generated JWT |
| `VITE_PARTYKIT_HOST` | Your PartyKit deployment host (see below) |

### PartyKit server (Cloudflare Durable Objects)

PartyKit deploys to Cloudflare Workers + Durable Objects. You'll need to authenticate once:

```bash
npx partykit login
```

Then deploy:

```bash
npx partykit deploy
```

Your server will be live at:
```
apple-music-party-radio.<your-github-username>.partykit.dev
```

Set `VITE_PARTYKIT_HOST` to that hostname (without `https://`) in your static hosting environment, then redeploy the client.

> **Note:** PartyKit persists Durable Object state across deployments. The station queue and pool survive server restarts.

### Keeping the developer token fresh

The Apple Music developer token expires after 180 days. Run `npm run generate-token` to regenerate it and update the environment variable in your hosting provider.
