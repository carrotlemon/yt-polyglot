# YT Polyglot

Show multiple language subtitles simultaneously on YouTube, stacked vertically so you can read all of them at once. Useful for language learning, translation comparison, or anywhere you want side-by-side captions in different languages.

Works in Chrome, Edge, Brave, Opera, Arc, and Firefox.

## Install — Chrome (and Chromium-based browsers)

Works in any Chromium browser: Chrome, Edge, Brave, Opera, Arc, Vivaldi.

1. Download or clone this repo to a folder on your machine.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, etc.).
3. Toggle **Developer mode** on (top-right corner).
4. Click **Load unpacked**.
5. Select the folder containing `manifest.json`.
6. The extension will appear in your toolbar. Pin it for easy access.

To update: pull the latest code and hit the **reload** button on the extension card.

## Install — Firefox

Firefox 109 or newer is required (for Manifest V3 support).

### Temporary install (resets when Firefox restarts)

1. Download or clone this repo to a folder on your machine.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select the `manifest.json` file in the project folder.

## How to use

1. Open any YouTube video that has subtitles available.
2. Click the **YT Polyglot** toolbar icon.
3. Search for languages or browse the list.
4. Check the languages you want to display.
5. The selected subtitles appear stacked above YouTube's player controls — the first one you picked sits at the bottom, the next one stacks above it, and so on.

### Popup controls

- **Search bar** — filter languages by name or ISO code.
- **Original only** — hide auto-translated languages, leaving only manually-uploaded tracks and auto-generated captions.
- **Clear all** — remove all active languages at once.
- The `#1`, `#2`, … badges show stacking order (top to bottom on screen, the lower the number the lower on the player).

## How it works

YouTube's caption tracks live behind a session-bound proof-of-origin token (`pot`) that third-party code can't reproduce. The extension works around this in three layers:

- **`bridge.js`** runs in the page's main world. It reads `window.ytInitialPlayerResponse` for the caption track list, and monkey-patches `fetch`/`XMLHttpRequest` to capture the URL that YouTube's own player uses when it loads captions. It then nudges the player to load captions once on page load so we have a working URL to work from.
- **`content.js`** runs in the extension's isolated world. It receives the captured URL via `postMessage`, rewrites `lang`/`tlang` on it for each language you want, fetches the subtitle XML, parses it, and renders overlay `<div>`s stacked above the player.
- **`popup.js`** drives the toolbar UI. It talks to `content.js` via `chrome.tabs.sendMessage` and persists your language picks in `chrome.storage.local`.

## Permissions

- **`storage`** — to remember which languages you have active.
- **`*://*.youtube.com/*`** — the content scripts run only on YouTube watch pages.

No data leaves your browser. No analytics, no remote servers.

## Project structure

```
ytpolyglot/
├── manifest.json     Extension manifest (MV3, works for Chrome + Firefox)
├── bridge.js         Runs in page's main world — reads player state, captures URLs
├── content.js        Runs in isolated world — fetches subtitles, renders overlays
├── content.css       Styles the subtitle overlays
├── popup.html        Toolbar popup markup
├── popup.js          Popup logic (search, filter, toggles)
├── popup.css         Popup styling
└── icons/            Extension icons (16, 48, 128 px)
```

## Limitations

- Only works on `youtube.com/watch` pages. Embedded players (other sites embedding YouTube) and YouTube Music are not supported.
- Relies on YouTube's player API for the URL capture. If YouTube significantly changes how the captions module is loaded, this approach may need updating.
- Auto-translated languages depend on YouTube's translation quality, which varies a lot by language pair.
- Subtitle position is fixed (stacked from the bottom of the player). No drag-to-reposition yet.

## Troubleshooting

Open YouTube's devtools console (F12) — the extension logs everything with a `[YTPolyglot]` prefix.

- **Popup says "No subtitle tracks found"** — the video has no captions, or you opened the popup before the page finished loading. Wait a second and reopen.
- **Subtitles activate but never appear** — check the console for `Captured working timedtext URL from YouTube player`. If that line is missing, the bridge couldn't trigger a caption fetch (rare; usually means a YouTube player API change).
- **Subtitles appear but are out of sync** — refresh the page. The XML parser uses the cue timing YouTube sends; if cues are missing for parts of the video, those gaps will be silent.
