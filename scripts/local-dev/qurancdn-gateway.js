/* eslint-disable max-lines, no-console, no-bitwise, no-continue, no-plusplus, no-nested-ternary */
/* eslint-disable no-await-in-loop, no-restricted-syntax, consistent-return, no-return-assign */
/* eslint-disable react-func/max-lines-per-function */
// Tiny local stand-in for the Quran Foundation API gateway.
//
// 1. Content API: the frontend's /api/proxy/content/... requests are forwarded to
//    API_GATEWAY_URL/content/..., which this maps onto the public https://api.qurancdn.com API:
//      /content/api/qdc/chapters  ->  https://api.qurancdn.com/api/qdc/chapters
//
// 2. Surah recitation audio: the official chapter MP3s live on download.quranicaudio.com, which some
//    networks can't reach. For reciters that also have verse-by-verse recordings
//    (audio.qurancdn.com / everyayah.com), this builds a chapter MP3 by joining the verse files,
//    recomputes verse + word timings for it, caches both on disk, and serves the MP3 back through
//    the app's own /api/proxy/content/local-audio/... path (same origin, so the app's CSP allows it).
//
// 3. Search: rebuilds the private search service's responses from public endpoints.
// 4. Learning plans: answers the course list with no courses (they need the private auth service).
//
// Run: node scripts/local-dev/qurancdn-gateway.js   (listens on http://localhost:4000)
// See scripts/local-dev/README.md for the full local setup.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const PORT = Number(process.env.PORT) || 4000;
const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:3100';
const UPSTREAM = 'api.qurancdn.com';
const CACHE_DIR = path.join(__dirname, '.audio-cache');
const DOWNLOAD_CONCURRENCY = 8;
// Headers that should not be forwarded upstream (the frontend's signing/cookies are irrelevant here).
const DROP = new Set([
  'host',
  'cookie',
  'connection',
  'x-auth-signature',
  'x-timestamp',
  'x-internal-client',
]);

// ---------- small HTTP helpers ----------

const get = (url, attempt = 1) =>
  new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'local-quran-dev' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(get(new URL(res.headers.location, url).toString(), attempt));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode !== 200) reject(new Error(`${res.statusCode} for ${url}`));
          else resolve(body);
        });
      })
      .on('error', reject);
  }).catch((err) => {
    if (attempt >= 3) throw err;
    return new Promise((r) => {
      setTimeout(r, 500 * attempt);
    }).then(() => get(url, attempt + 1));
  });

const getJson = async (url) => JSON.parse((await get(url)).toString('utf8'));

const sendJson = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

// ---------- MP3 handling ----------

const BITRATES = {
  // [version][layer] -> kbps table (index 1..14). We only need Layer III.
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

const parseFrameHeader = (buf, i) => {
  if (i + 4 > buf.length || buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[i + 1] >> 3) & 3;
  const layerBits = (buf[i + 1] >> 1) & 3;
  const bitrateIdx = buf[i + 2] >> 4;
  const srIdx = (buf[i + 2] >> 2) & 3;
  const padding = (buf[i + 2] >> 1) & 1;
  if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3)
    return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const bitrate = BITRATES[version === 1 ? 1 : 2][bitrateIdx] * 1000;
  const sampleRate = SAMPLE_RATES[version][srIdx];
  const samples = version === 1 ? 1152 : 576;
  const size = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  const mono = buf[i + 3] >> 6 === 3;
  return { size, samples, sampleRate, version, mono, bitrate };
};

// Strips ID3v2/ID3v1 tags and Xing/Info/VBRI header frames, returns the raw audio frames + exact duration.
const extractFrames = (buf) => {
  let start = 0;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') {
    const size =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  let end = buf.length;
  if (end >= 128 && buf.slice(end - 128, end - 125).toString('latin1') === 'TAG') end -= 128;

  const parts = [];
  let durationSec = 0;
  let sampleRate = null;
  const bitrates = new Set();
  let first = true;
  let i = start;
  while (i < end) {
    const h = parseFrameHeader(buf, i);
    if (!h || i + h.size > end) {
      i += 1; // lost sync: scan forward to the next frame header
      continue;
    }
    if (first) {
      first = false;
      const sideInfo = h.version === 1 ? (h.mono ? 17 : 32) : h.mono ? 9 : 17;
      const tag = buf.slice(i + 4 + sideInfo, i + 8 + sideInfo).toString('latin1');
      const vbri = buf.slice(i + 36, i + 40).toString('latin1');
      if (tag === 'Xing' || tag === 'Info' || vbri === 'VBRI') {
        i += h.size; // metadata-only frame; would make browsers think the whole stream is one verse long
        continue;
      }
    }
    parts.push(buf.subarray(i, i + h.size));
    durationSec += h.samples / h.sampleRate;
    sampleRate = sampleRate || h.sampleRate;
    bitrates.add(h.bitrate);
    i += h.size;
  }
  return { data: Buffer.concat(parts), durationMs: durationSec * 1000, sampleRate, bitrates };
};

// Joined verse files can mix bitrates (e.g. 192k and 128k). Browsers then guess the stream length and
// seek positions from the first frame's bitrate, which breaks the progress bar and seeking. Re-encoding
// to one constant bitrate fixes that; decoded length (and so all timings) stays the same.
const reencodeToCbr = (inputPath, outputPath, kbps) =>
  new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      inputPath,
      '-c:a',
      'libmp3lame',
      '-b:a',
      `${kbps}k`,
      outputPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)),
    );
  });

// ---------- chapter audio building ----------

const toVerseFileUrl = (url) => {
  const everyayah = url.match(/^\/\/mirrors\.quranicaudio\.com\/everyayah\/(.+)$/);
  if (everyayah) return `https://everyayah.com/data/${everyayah[1]}`;
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//.test(url)) return url;
  return `https://audio.qurancdn.com/${url}`;
};

const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const fetchVerseFiles = async (reciterId, chapter) => {
  const files = [];
  for (let page = 1; page < 50; page++) {
    const data = await getJson(
      `https://${UPSTREAM}/api/v4/recitations/${reciterId}/by_chapter/${chapter}?per_page=50&page=${page}&fields=segments`,
    );
    files.push(...(data.audio_files || []));
    if (!data.pagination || !data.pagination.next_page) break;
  }
  return files;
};

const building = new Map();

const buildChapter = (reciterId, chapter) => {
  const key = `${reciterId}/${chapter}`;
  const dir = path.join(CACHE_DIR, String(reciterId));
  const mp3Path = path.join(dir, `${chapter}.mp3`);
  const metaPath = path.join(dir, `${chapter}.json`);
  if (fs.existsSync(mp3Path) && fs.existsSync(metaPath)) {
    return Promise.resolve({ mp3Path, meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) });
  }
  if (building.has(key)) return building.get(key);

  const job = (async () => {
    const t0 = Date.now();
    const verses = await fetchVerseFiles(reciterId, chapter);
    if (!verses.length)
      throw new Error(`No verse audio for reciter ${reciterId}, chapter ${chapter}`);
    const extracted = await mapLimit(verses, DOWNLOAD_CONCURRENCY, async (v) =>
      extractFrames(await get(toVerseFileUrl(v.url))),
    );

    let offset = 0;
    const verseTimings = verses.map((v, idx) => {
      const { durationMs } = extracted[idx];
      const segments = (v.segments || [])
        .filter(
          (s) => Array.isArray(s) && (s.length === 4 || s.length === 3) && s.every(Number.isFinite),
        )
        .map((s) => (s.length === 4 ? [s[1], s[2], s[3]] : s))
        .map(([pos, from, to]) => [pos, Math.round(offset + from), Math.round(offset + to)]);
      const timing = {
        verse_key: v.verse_key,
        timestamp_from: Math.round(offset),
        timestamp_to: Math.round(offset + durationMs),
        duration: Math.round(durationMs),
        segments,
      };
      offset += durationMs;
      return timing;
    });

    const audio = Buffer.concat(extracted.map((e) => e.data));
    const bitrates = new Set(extracted.flatMap((e) => [...e.bitrates]));
    fs.mkdirSync(dir, { recursive: true });
    let reencoded = false;
    if (bitrates.size > 1) {
      const rawPath = path.join(dir, `${chapter}.joined.mp3`);
      fs.writeFileSync(rawPath, audio);
      const kbps = Math.min(192, Math.max(...bitrates) / 1000);
      try {
        await reencodeToCbr(rawPath, mp3Path, kbps);
        fs.unlinkSync(rawPath);
        reencoded = true;
      } catch (err) {
        // Without ffmpeg the joined file still plays and stays in sync; only the reported length and
        // seeking positions are approximate.
        console.warn(`ffmpeg re-encode failed (${err.message}); serving the joined file as-is`);
        fs.renameSync(rawPath, mp3Path);
      }
    } else {
      fs.writeFileSync(mp3Path, audio);
    }
    const fileSize = fs.statSync(mp3Path).size;
    const meta = { duration: Math.round(offset), file_size: fileSize, verse_timings: verseTimings };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    console.log(
      `built ${key}: ${verses.length} verses, ${(fileSize / 1e6).toFixed(1)} MB` +
        `${reencoded ? ' (re-encoded to CBR)' : ''} in ${Date.now() - t0} ms`,
    );
    return { mp3Path, meta };
  })().finally(() => building.delete(key));

  building.set(key, job);
  return job;
};

const handleAudioFiles = async (req, res, reciterId, query) => {
  const chapter = Number(query.get('chapter'));
  if (!chapter) return false;
  let built;
  try {
    built = await buildChapter(reciterId, chapter);
  } catch (err) {
    console.warn(`audio fallback to upstream for ${reciterId}/${chapter}: ${err.message}`);
    return false; // e.g. reciter has no verse-by-verse files: let upstream answer as before
  }
  const withSegments = query.get('segments') === 'true';
  const { meta } = built;
  sendJson(res, 200, {
    audio_files: [
      {
        id: Number(`${reciterId}${String(chapter).padStart(3, '0')}`),
        chapter_id: chapter,
        file_size: meta.file_size,
        format: 'mp3',
        audio_url: `${APP_ORIGIN}/api/proxy/content/local-audio/${reciterId}/${chapter}.mp3`,
        duration: meta.duration,
        ...(withSegments ? { verse_timings: meta.verse_timings } : {}),
      },
    ],
  });
  return true;
};

const serveMp3 = async (req, res, reciterId, chapter) => {
  let built;
  try {
    built = await buildChapter(reciterId, chapter);
  } catch (err) {
    sendJson(res, 502, { error: 'Could not build chapter audio', message: err.message });
    return;
  }
  const { size } = fs.statSync(built.mp3Path);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const headers = {
    'content-type': 'audio/mpeg',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  };
  if (range) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(built.mp3Path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(built.mp3Path).pipe(res);
};

// ---------- search ----------
// The app calls the private search service (/search/v1/search?mode=quick|advanced&query=...).
// Rebuild its response from the public endpoints: /api/qdc/navigate for jump-to results (surah, juz,
// page, verse key...) and /api/v4/search for matching verses with highlighted translations.

const UNAVAILABLE_TRANSLATIONS = new Set(['131']); // licensed; withheld by the public API
const FALLBACK_TRANSLATION = '20'; // Saheeh International
const ARABIC_SCRIPT = /[؀-ۿ]/;

const handleSearch = async (res, params) => {
  const query = (params.get('query') || '').trim();
  const perPage = Math.min(Number(params.get('per_page') || params.get('size')) || 10, 50);
  const page = Number(params.get('page')) || 1;
  const translationIds = (params.get('translation_ids') || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && !UNAVAILABLE_TRANSLATIONS.has(id));
  const translations = translationIds.length ? translationIds.join(',') : FALLBACK_TRANSLATION;

  if (!query) {
    sendJson(res, 200, {
      result: { navigation: [], verses: [] },
      pagination: {
        per_page: perPage,
        current_page: 1,
        next_page: null,
        total_records: 0,
        total_pages: 0,
      },
    });
    return;
  }

  const q = encodeURIComponent(query);
  const [nav, found] = await Promise.all([
    page === 1
      ? getJson(`https://${UPSTREAM}/api/qdc/navigate?query=${q}`).catch(() => null)
      : Promise.resolve(null),
    getJson(
      `https://${UPSTREAM}/api/v4/search?q=${q}&size=${perPage}&page=${page}&translations=${translations}`,
    ),
  ]);

  const isArabicQuery = ARABIC_SCRIPT.test(query);
  const search = found.search || {};
  const verses = (search.results || []).map((r) => {
    const translation = (r.translations || [])[0];
    const matchedInArabic = isArabicQuery || !translation;
    return {
      result_type: 'ayah',
      key: r.verse_key,
      name: matchedInArabic ? r.highlighted || r.text : translation.text,
      arabic: r.text,
      is_arabic: matchedInArabic,
    };
  });

  const totalPages = search.total_pages || 0;
  sendJson(res, 200, {
    result: { navigation: (nav && nav.result && nav.result.navigation) || [], verses },
    pagination: {
      per_page: perPage,
      current_page: search.current_page || page,
      next_page:
        (search.current_page || page) < totalPages ? (search.current_page || page) + 1 : null,
      total_records: search.total_results || 0,
      total_pages: totalPages,
    },
  });
};

// ---------- plain pass-through to api.qurancdn.com ----------

const passThrough = (req, res, upstreamPath) => {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) headers[k] = v;
  headers.host = UPSTREAM;

  const upstream = https.request(
    { host: UPSTREAM, path: upstreamPath, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) =>
    sendJson(res, 502, { error: 'Upstream error', message: err.message }),
  );
  req.pipe(upstream);
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    const mp3 = url.pathname.match(/^\/content\/local-audio\/(\d+)\/(\d+)\.mp3$/);
    if (mp3) return serveMp3(req, res, Number(mp3[1]), Number(mp3[2]));

    const audioFiles = url.pathname.match(
      /^\/content\/api\/qdc\/audio\/reciters\/(\d+)\/audio_files$/,
    );
    if (audioFiles && req.method === 'GET') {
      if (await handleAudioFiles(req, res, Number(audioFiles[1]), url.searchParams)) return;
    }

    if (url.pathname === '/search/v1/search' && req.method === 'GET') {
      try {
        await handleSearch(res, url.searchParams);
      } catch (err) {
        sendJson(res, 502, { error: 'Search upstream error', message: err.message });
      }
      return;
    }

    // Learning plans (courses) live only on the private auth service, which needs a signing secret we
    // don't have. Answer the list with no courses so the app hides the section instead of erroring.
    if (url.pathname === '/auth/courses' && req.method === 'GET') {
      sendJson(res, 200, { success: true, data: [], pagination: { hasNextPage: false } });
      return;
    }

    const content = req.url.match(/^\/content(\/.*)$/);
    if (content) return passThrough(req, res, content[1]);

    sendJson(res, 404, { error: `Not available via local gateway: ${req.url}` });
  })
  .listen(PORT, () => console.log(`qurancdn gateway listening on http://localhost:${PORT}`));
