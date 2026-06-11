// YT Polyglot bridge — runs in MAIN world so it can:
//   1. Read window.ytInitialPlayerResponse
//   2. Intercept fetch/XHR to capture YouTube's own signed timedtext URLs
//      (the baseUrl exposed in playerResponse is missing the session-bound
//      `pot` token, so direct fetches return an empty HTML body)
//   3. Programmatically trigger YT to load captions so a fetch happens

(function () {
  const CHANNEL = '__YTPOLYGLOT__';

  // ─── Player-response broadcast ───────────────────────────────────────────

  function snapshot() {
    return window.ytInitialPlayerResponse || null;
  }

  function send(reason) {
    const data = snapshot();
    if (!data) return;
    window.postMessage(
      { channel: CHANNEL, type: 'PLAYER_RESPONSE', reason, data },
      '*'
    );
  }

  send('init');
  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => send('navigate'), 200);
    setTimeout(() => send('navigate-delayed'), 1200);
  });
  let lastSig = '';
  setInterval(() => {
    const r = snapshot();
    if (!r) return;
    const sig =
      (r.videoDetails?.videoId || '') +
      '|' +
      (r.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length || 0);
    if (sig !== lastSig) {
      lastSig = sig;
      send('poll');
    }
  }, 800);

  // ─── Network interception ────────────────────────────────────────────────

  function reportTimedTextUrl(url) {
    try {
      // Resolve relative URLs against the page
      const abs = new URL(url, location.href).toString();
      window.postMessage(
        { channel: CHANNEL, type: 'TIMEDTEXT_URL', url: abs },
        '*'
      );
    } catch (e) {}
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const input = args[0];
      const url =
        typeof input === 'string'
          ? input
          : input?.url || (input?.href ? input.href : '');
      if (url && url.includes('/api/timedtext')) reportTimedTextUrl(url);
    } catch (e) {}
    return origFetch.apply(this, args);
  };

  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === 'string' && url.includes('/api/timedtext')) {
        reportTimedTextUrl(url);
      }
    } catch (e) {}
    return origXhrOpen.call(this, method, url, ...rest);
  };

  // ─── Caption-load trigger ────────────────────────────────────────────────
  // Asking the YouTube player to load any caption track causes it to perform a
  // real fetch — which our interceptor above will capture.

  let triggered = false;
  function triggerCaptionLoad(retries = 20) {
    if (triggered) return;
    const player = document.getElementById('movie_player');
    const tracks =
      window.ytInitialPlayerResponse?.captions
        ?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!player?.loadModule || !tracks?.length) {
      if (retries > 0) setTimeout(() => triggerCaptionLoad(retries - 1), 400);
      return;
    }
    triggered = true;
    try {
      player.loadModule('captions');
      player.setOption('captions', 'track', {
        languageCode: tracks[0].languageCode,
      });
      // We don't actually want YT's captions visible — unload shortly after.
      // The fetch is already in flight by this point.
      setTimeout(() => {
        try { player.unloadModule('captions'); } catch (e) {}
      }, 800);
    } catch (e) {
      console.warn('[YTPolyglot bridge] trigger failed:', e);
      triggered = false;
      if (retries > 0) setTimeout(() => triggerCaptionLoad(retries - 1), 400);
    }
  }

  // Trigger once on initial load
  setTimeout(() => triggerCaptionLoad(), 1500);

  // Re-trigger on navigation to a new video
  document.addEventListener('yt-navigate-finish', () => {
    triggered = false;
    setTimeout(() => triggerCaptionLoad(), 1500);
  });

  // Allow content.js to ask us to trigger explicitly
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.channel !== CHANNEL) return;
    if (e.data.type === 'REQUEST_PLAYER_RESPONSE') send('request');
    if (e.data.type === 'TRIGGER_CAPTION_LOAD') {
      triggered = false;
      triggerCaptionLoad();
    }
  });
})();
