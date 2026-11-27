# Running Quran.com locally without the private API gateway

These files let you run the frontend locally against the **public** Quran.com CDN API
(`api.qurancdn.com`) instead of the private Quran Foundation API gateway, which needs a signing
secret. They also work on networks where `quran.com`, `api.quran.com` and
`download.quranicaudio.com` are unreachable, as long as `*.qurancdn.com` is reachable.

| File                        | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `qurancdn-gateway.js`       | Small local server on port 4000 standing in for the API gateway     |
| `env.local.example`         | Environment for the app, pointing it at the local gateway           |
| `../../.claude/launch.json` | Starts the gateway and the dev server together (Claude desktop app) |

## Setup

Requirements: Node 20 (the repo pins 18.x; 20 works with `--ignore-engines`), Yarn 1, and optionally
`ffmpeg` (see [Recitation audio](#recitation-audio)).

```bash
HUSKY=0 yarn install --ignore-engines
cp scripts/local-dev/env.local.example .env.local
node scripts/local-dev/qurancdn-gateway.js      # terminal 1, http://localhost:4000
yarn --ignore-engines dev -p 3100               # terminal 2, http://localhost:3100
```

The app must run on the port in `NEXT_PUBLIC_VERCEL_URL` (3100 here), because server-side requests
go to that address. If you change it, also start the gateway with
`APP_ORIGIN=http://localhost:<port>` so recitation audio URLs point at the right place.

## Private local app (macOS)

A **Quran** app for your Applications folder that runs a production build of this repo, reachable
only from this machine. Create it once:

```bash
scripts/local-dev/local-app.sh make-app   # creates ~/Applications/Quran.app
```

Then just open **Quran** (Spotlight, Launchpad or `~/Applications`):

- It starts the app and gateway and opens the Quran window (about 3 seconds).
- If the checked-out commit changed since the last build (e.g. after `git pull`), it rebuilds first
  and shows a notification (a few minutes).
- It never leaves you without a working app: while a merge, rebase or cherry-pick is unfinished (or
  files have conflicts) it skips the update, and if an update fails to build it restores the
  previous build. Either way it opens the last working version and says so in a notification. A
  failed commit isn't retried on every launch; the next commit (e.g. your fix) is built as usual.
- Closing the window (or quitting it) stops everything; nothing keeps running in the background.

The app icon is `scripts/local-dev/app-icon.png`, the logo rendered on Apple's icon grid (824px
rounded square with a soft shadow on a 1024px canvas). Run `make-app` again after changing it.

The window runs in its own Chrome instance with a separate profile in
`~/Library/Application Support/QuranLocal/`, so settings and reading position persist between
launches. It needs Google Chrome installed. Everything listens on `127.0.0.1` only (app 3200,
gateway 4100, the window's DevTools port 9334), so other devices on your network can't reach it, and
it can run next to the dev setup. Logs: `~/Library/Logs/quran-local/app.log`.

`scripts/local-dev/local-app.sh build` and `start` run the build or the servers by hand.

## How it works

The app sends API calls to its own `/api/proxy/<service>/...` route, which forwards them to
`API_GATEWAY_URL/<service>/...`. The gateway handles:

- **`/content/...`**: forwarded to `https://api.qurancdn.com/...` (chapters, verses, translations,
  tafsir, reciters, etc.).
- **`/content/api/qdc/audio/reciters/:id/audio_files`**: see below.
- **`/search/v1/search`**: rebuilt from `/api/qdc/navigate` (jump-to results such as surahs, juz,
  pages, verse keys) and `/api/v4/search` (verse matches with highlighted translations).
- **`/auth/courses`**: answered with an empty list, so the Learning Plans section hides itself
  instead of showing an error.

### Recitation audio

Full-surah recitations are normally served from `download.quranicaudio.com`. For reciters that also
have verse-by-verse recordings (ids 1-7, 9, 10, 12), the gateway downloads the verse files from
`audio.qurancdn.com` / `everyayah.com`, joins them into one chapter MP3, recomputes the verse and
word timings (so highlighting stays in sync) and caches the result in
`scripts/local-dev/.audio-cache/`. The first play of a long surah takes a while (Al-Baqarah has 286
verse files); later plays come from the cache.

Some reciters mix bitrates between verse files. The gateway then re-encodes the joined file to a
constant bitrate with `ffmpeg` so browsers report the right length and seek correctly. Without
`ffmpeg` the audio still plays in sync, but the progress bar and seeking are approximate.

## What doesn't work

These need the private services and are unavailable locally:

- Sign-in and everything tied to an account (synced bookmarks, notes, goals and streaks, learning
  plans).
- The "The Clear Quran" translation (id 131), which the public API doesn't serve. Search results use
  Saheeh International instead.
- Reciters without verse-by-verse files (e.g. 97, 161, 168, 173).
- A few count badges in the reader (hadith references, qiraat, layered translations).
- Full-text search on transliterated names (e.g. "Isra") only returns the jump-to result.
