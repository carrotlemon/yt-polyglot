// YT Polyglot — multi-language subtitle overlay for YouTube
// Receives ytInitialPlayerResponse from bridge.js (which runs in MAIN world).

const STORAGE_KEY = 'ytpolyglot_active_langs';
const SHOW_LABELS_KEY = 'ytpolyglot_show_labels';
const CHANNEL = '__YTPOLYGLOT__';
const SUBTITLE_HEIGHT = 56;
const SUBTITLE_BASE_BOTTOM = 80;
const LOG = (...args) => console.log('[YTPolyglot]', ...args);

let state = freshState();
// Working timedtext URL captured from YouTube's own player — required because
// the baseUrl in playerResponse is missing the session `pot` token.
let urlTemplate = null;

function freshState() {
  return {
    videoId: null,
    tracks: [],
    activeLangs: [],
    subtitleData: {},
    overlays: {},
    video: null,
    playerContainer: null,
  };
}

// ─── Bridge listener ──────────────────────────────────────────────────────────

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.channel !== CHANNEL) return;
  if (e.data.type === 'PLAYER_RESPONSE') {
    handlePlayerResponse(e.data.data, e.data.reason);
  }
  if (e.data.type === 'TIMEDTEXT_URL') {
    onTimedTextUrl(e.data.url);
  }
});

function onTimedTextUrl(url) {
  if (urlTemplate === url) return;
  urlTemplate = url;
  LOG('Captured working timedtext URL from YouTube player');

  // Retry any active langs that previously failed or weren't fetched yet
  const toRetry = state.activeLangs.filter(
    (l) => !state.subtitleData[l] || state.subtitleData[l].length === 0
  );
  if (toRetry.length === 0) return;
  toRetry.forEach((l) => delete state.subtitleData[l]);
  loadSubtitles(state.activeLangs).then(() => {
    rebuildOverlays();
    if (state.video) syncSubtitles();
  });
}

function requestPlayerResponse() {
  window.postMessage(
    { channel: CHANNEL, type: 'REQUEST_PLAYER_RESPONSE' },
    '*'
  );
}

async function handlePlayerResponse(response, reason) {
  const videoId = response?.videoDetails?.videoId;
  if (!videoId) return;

  // If this is a new video, reset everything
  if (videoId !== state.videoId) {
    LOG('New video detected', videoId, '(reason:', reason + ')');
    teardown();
    state.videoId = videoId;
  }

  const tracks = extractTracks(response);
  if (tracks.length === 0) {
    LOG('No caption tracks in player response');
    return;
  }
  state.tracks = tracks;
  const native = tracks.filter((t) => !t.isAsr && !t.isTranslated).length;
  const asr = tracks.filter((t) => t.isAsr).length;
  const translated = tracks.filter((t) => t.isTranslated).length;
  LOG(`Tracks: ${tracks.length} total (${native} native, ${asr} auto-gen, ${translated} auto-translated)`);

  await ensureVideoAndContainer();
  if (!state.video || !state.playerContainer) {
    LOG('Player not ready yet, will retry on next message');
    return;
  }

  const stored = await storageGet(STORAGE_KEY);
  state.activeLangs = stored || [];
  await loadSubtitles(state.activeLangs);
  rebuildOverlays();
  attachVideoListener();
}

// ─── Track extraction ─────────────────────────────────────────────────────────

const LANG_DISPLAY = (() => {
  try {
    return new Intl.DisplayNames(['en'], {
      type: 'language',
      fallback: 'none',
    });
  } catch (e) {
    return null;
  }
})();

function resolveLangName(nameObj, code) {
  const fromYt = nameObj?.simpleText || nameObj?.runs?.[0]?.text;
  if (fromYt && fromYt !== code && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(fromYt)) {
    return fromYt;
  }
  if (LANG_DISPLAY) {
    try {
      const intl = LANG_DISPLAY.of(code);
      if (intl) return intl;
    } catch (e) {}
  }
  return fromYt || code;
}

function extractTracks(response) {
  const captionTracks =
    response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const translationLangs =
    response?.captions?.playerCaptionsTracklistRenderer?.translationLanguages ||
    [];

  const tracks = captionTracks.map((t) => ({
    lang: t.languageCode,
    name: resolveLangName(t.name, t.languageCode),
    url: t.baseUrl,
    isAsr: t.kind === 'asr',
  }));

  const sourceTrack =
    captionTracks.find((t) => t.kind === 'asr') || captionTracks[0];
  if (sourceTrack && translationLangs.length) {
    for (const tl of translationLangs) {
      if (tracks.find((t) => t.lang === tl.languageCode)) continue;
      tracks.push({
        lang: tl.languageCode,
        name: resolveLangName(tl.languageName, tl.languageCode),
        url: sourceTrack.baseUrl + `&tlang=${tl.languageCode}`,
        isTranslated: true,
      });
    }
  }
  return tracks;
}

// ─── DOM readiness ────────────────────────────────────────────────────────────

async function ensureVideoAndContainer() {
  for (let i = 0; i < 20; i++) {
    state.video = document.querySelector('video');
    state.playerContainer =
      document.querySelector('#movie_player') ||
      document.querySelector('.html5-video-container');
    if (state.video && state.playerContainer) return;
    await sleep(250);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Subtitle fetching ────────────────────────────────────────────────────────

async function loadSubtitles(langs) {
  const missing = langs.filter((l) => !state.subtitleData[l]);
  await Promise.all(missing.map(fetchSubtitleTrack));
}

async function fetchSubtitleTrack(lang) {
  const track = state.tracks.find((t) => t.lang === lang);
  if (!track) return;

  const url = buildSubtitleUrl(track);
  try {
    const res = await fetch(url);
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      console.warn(`[YTPolyglot] HTTP ${res.status} for ${lang}`, url);
      state.subtitleData[lang] = [];
      return;
    }
    const body = await res.text();
    if (!body.trim()) {
      LOG(`Empty body for ${lang} (content-type: ${contentType})`);
      state.subtitleData[lang] = [];
      return;
    }
    const cues = parseTimedText(body);
    state.subtitleData[lang] = cues;
    LOG(
      `Loaded ${cues.length} cues for ${lang}`,
      cues[0] ? `(first: "${cues[0].text}" @ ${cues[0].start.toFixed(1)}s)` : `[body preview: ${body.slice(0, 120)}]`
    );
  } catch (e) {
    console.warn('[YTPolyglot] Fetch failed for', lang, e);
    state.subtitleData[lang] = [];
  }
}

function buildSubtitleUrl(track) {
  // Prefer the URL captured from YT's own player (carries `pot` + signatures).
  if (urlTemplate) {
    const u = new URL(urlTemplate, location.origin);
    if (track.isTranslated) {
      // Source language stays as captured; translate target = our lang
      u.searchParams.set('tlang', track.lang);
    } else {
      u.searchParams.delete('tlang');
      u.searchParams.set('lang', track.lang);
      // Drop `kind=asr` for native tracks; keep it for ASR
      if (track.isAsr) u.searchParams.set('kind', 'asr');
      else u.searchParams.delete('kind');
    }
    u.searchParams.set('fmt', 'srv3');
    return u.toString();
  }
  // Fallback: playerResponse baseUrl (often fails for newer videos)
  let url = track.url;
  if (!/[?&]fmt=/.test(url)) url += '&fmt=srv3';
  return url;
}

function parseTimedText(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    console.warn('[YTPolyglot] XML parse error:', parseError.textContent.slice(0, 200));
  }

  // getElementsByTagName is namespace-agnostic and matches reliably across
  // both YouTube formats:
  //   srv1/default: <text start="0.5" dur="2.3">…</text>  (seconds)
  //   srv3:         <p t="500" d="2300">…</p>             (milliseconds)
  const textEls = Array.from(doc.getElementsByTagName('text'));
  const pEls = Array.from(doc.getElementsByTagName('p'));

  const out = [];
  if (textEls.length) {
    for (const el of textEls) {
      const start = parseFloat(el.getAttribute('start') || '0');
      const dur = parseFloat(el.getAttribute('dur') || '2');
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text) out.push({ start, end: start + dur, text });
    }
  } else {
    for (const el of pEls) {
      const t = parseFloat(el.getAttribute('t') || '0') / 1000;
      const d = parseFloat(el.getAttribute('d') || '2000') / 1000;
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text) out.push({ start: t, end: t + d, text });
    }
  }
  return out;
}

// ─── Overlay rendering ────────────────────────────────────────────────────────

function rebuildOverlays() {
  for (const lang of Object.keys(state.overlays)) {
    if (!state.activeLangs.includes(lang)) {
      state.overlays[lang].remove();
      delete state.overlays[lang];
    }
  }

  state.activeLangs.forEach((lang, idx) => {
    let el = state.overlays[lang];
    if (!el) {
      const track = state.tracks.find((t) => t.lang === lang);
      el = document.createElement('div');
      el.className = 'ytpolyglot-subtitle';
      el.dataset.lang = lang;

      const label = document.createElement('span');
      label.className = 'ytpolyglot-lang-label';
      label.textContent = track?.name || lang;
      el.appendChild(label);

      const textEl = document.createElement('span');
      textEl.className = 'ytpolyglot-text';
      el.appendChild(textEl);

      state.playerContainer.appendChild(el);
      state.overlays[lang] = el;
    }
    el.style.bottom = `${SUBTITLE_BASE_BOTTOM + idx * SUBTITLE_HEIGHT}px`;
  });

  const nativeCaptions = document.querySelector('.ytp-caption-window-container');
  if (nativeCaptions) {
    nativeCaptions.style.display = state.activeLangs.length ? 'none' : '';
  }
}

// ─── Sync loop ────────────────────────────────────────────────────────────────

function attachVideoListener() {
  if (!state.video) return;
  state.video.removeEventListener('timeupdate', syncSubtitles);
  state.video.addEventListener('timeupdate', syncSubtitles);
}

function syncSubtitles() {
  const t = state.video.currentTime;
  for (const lang of state.activeLangs) {
    const overlay = state.overlays[lang];
    const data = state.subtitleData[lang];
    if (!overlay || !data) continue;
    const cue = findCue(data, t);
    const textEl = overlay.querySelector('.ytpolyglot-text');
    if (cue) {
      if (textEl.textContent !== cue.text) textEl.textContent = cue.text;
      overlay.classList.add('visible');
    } else {
      if (textEl.textContent) textEl.textContent = '';
      overlay.classList.remove('visible');
    }
  }
}

function findCue(cues, t) {
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

// True while the extension context is still attached. Becomes false after the
// extension is reloaded/updated — the page's existing content script is then
// orphaned and any chrome.* call would throw "Extension context invalidated".
function extensionAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function storageGet(key, defaultValue = []) {
  return new Promise((resolve) => {
    if (!extensionAlive()) return resolve(defaultValue);
    try {
      chrome.storage.local.get({ [key]: defaultValue }, (v) => {
        if (chrome.runtime?.lastError) return resolve(defaultValue);
        resolve(v[key]);
      });
    } catch {
      resolve(defaultValue);
    }
  });
}

try {
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (!extensionAlive() || area !== 'local') return;
    try {
      if (changes[SHOW_LABELS_KEY]) {
        applyShowLabels(changes[SHOW_LABELS_KEY].newValue === true);
      }

      if (!changes[STORAGE_KEY]) return;
      state.activeLangs = changes[STORAGE_KEY].newValue || [];
      LOG('Active languages changed →', state.activeLangs);

      // Race-condition guard: if user toggled before the bridge finished
      // delivering the player response, we may have empty tracks or no
      // container yet.
      if (state.tracks.length === 0) requestPlayerResponse();
      await ensureVideoAndContainer();
      if (!state.playerContainer) {
        console.warn('[YTPolyglot] Player container not ready, skipping overlay build');
        return;
      }

      await loadSubtitles(state.activeLangs);
      rebuildOverlays();
      attachVideoListener();
      if (state.video) syncSubtitles();
    } catch (e) {
      if (!String(e).includes('Extension context invalidated')) {
        console.warn('[YTPolyglot] onChanged error:', e);
      }
    }
  });
} catch {}

function applyShowLabels(on) {
  document.documentElement.classList.toggle('ytpolyglot-show-labels', !!on);
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

function teardown() {
  document
    .querySelectorAll('.ytpolyglot-subtitle')
    .forEach((el) => el.remove());
  if (state.video) state.video.removeEventListener('timeupdate', syncSubtitles);
  const nativeCaptions = document.querySelector('.ytp-caption-window-container');
  if (nativeCaptions) nativeCaptions.style.display = '';
  state = freshState();
}

// ─── Popup messaging ──────────────────────────────────────────────────────────

try {
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!extensionAlive()) return;
    try {
      if (msg.type === 'GET_TRACKS') {
        if (state.tracks.length === 0) requestPlayerResponse();
        respond({ tracks: state.tracks, activeLangs: state.activeLangs });
      }
    } catch {}
    return true;
  });
} catch {}

// ─── Kickoff ──────────────────────────────────────────────────────────────────

LOG('Content script loaded — build', '2026-06-11d');
document.documentElement.classList.add('ytpolyglot-loaded');

// Restore persisted "show labels" preference (default off)
storageGet(SHOW_LABELS_KEY, false).then(applyShowLabels);

// Ask the bridge to send us the current player response immediately.
requestPlayerResponse();
