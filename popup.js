const STORAGE_KEY = 'ytpolyglot_active_langs';
const FILTER_KEY = 'ytpolyglot_hide_translated';
const SHOW_LABELS_KEY = 'ytpolyglot_show_labels';

let allTracks = [];
let activeLangs = [];
let searchQuery = '';
let hideTranslated = false;
let showLabels = false;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('youtube.com/watch')) {
    showState('no-tracks');
    return;
  }

  // Load persisted preferences
  const prefs = await chrome.storage.local.get({
    [FILTER_KEY]: false,
    [SHOW_LABELS_KEY]: false,
  });
  hideTranslated = prefs[FILTER_KEY];
  showLabels = prefs[SHOW_LABELS_KEY];
  document
    .getElementById('filter-translated')
    .classList.toggle('active', hideTranslated);
  document.getElementById('show-labels').checked = showLabels;

  // Retry up to ~3s in case the bridge hasn't relayed the player response yet
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRACKS' });
      if (res && res.tracks.length > 0) {
        allTracks = res.tracks;
        activeLangs = res.activeLangs || [];
        document.getElementById('controls').classList.remove('hidden');
        document.getElementById('settings').classList.remove('hidden');
        renderList();
        return;
      }
    } catch {
      // content script may not be ready yet — keep trying
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  showState('no-tracks');
}

function showState(id) {
  for (const sid of ['loading', 'no-tracks', 'no-matches', 'track-list']) {
    document.getElementById(sid).classList.toggle('hidden', sid !== id);
  }
}

function filteredTracks() {
  const q = searchQuery.trim().toLowerCase();
  return allTracks.filter((t) => {
    if (hideTranslated && t.isTranslated) return false;
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      t.lang.toLowerCase().includes(q)
    );
  });
}

function renderList() {
  const tracks = filteredTracks();
  if (tracks.length === 0) {
    showState(searchQuery || hideTranslated ? 'no-matches' : 'no-tracks');
    updateFooter();
    return;
  }
  showState('track-list');

  const list = document.getElementById('track-list');
  list.innerHTML = '';

  // Sort: active langs first (in selection order), then alphabetical
  const activeSet = new Set(activeLangs);
  const sorted = [
    ...activeLangs
      .map((l) => tracks.find((t) => t.lang === l))
      .filter(Boolean),
    ...tracks
      .filter((t) => !activeSet.has(t.lang))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];

  for (const track of sorted) {
    const idx = activeLangs.indexOf(track.lang);
    const isActive = idx !== -1;

    const item = document.createElement('label');
    item.className = 'track-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isActive;
    checkbox.addEventListener('change', () =>
      toggleLang(track.lang, checkbox.checked)
    );

    const info = document.createElement('div');
    info.className = 'track-info';

    const name = document.createElement('div');
    name.className = 'track-name';
    name.textContent = track.name;

    const tag = document.createElement('div');
    tag.className = 'track-tag';
    const tags = [track.lang];
    if (track.isAsr) tags.push('auto-generated');
    if (track.isTranslated) tags.push('auto-translated');
    tag.textContent = tags.join(' · ');

    info.appendChild(name);
    info.appendChild(tag);

    const badge = document.createElement('span');
    badge.className = 'order-badge';
    badge.textContent = isActive ? `#${idx + 1}` : '';

    item.appendChild(checkbox);
    item.appendChild(info);
    item.appendChild(badge);
    list.appendChild(item);
  }

  updateFooter();
}

async function toggleLang(lang, on) {
  if (on) {
    if (!activeLangs.includes(lang)) activeLangs.push(lang);
  } else {
    activeLangs = activeLangs.filter((l) => l !== lang);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: activeLangs });
  renderList();
}

function updateFooter() {
  document.getElementById('active-count').textContent =
    activeLangs.length === 0 ? 'None active' : `${activeLangs.length} active`;
}

document.getElementById('clear-btn').addEventListener('click', async () => {
  activeLangs = [];
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  renderList();
});

document.getElementById('search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderList();
});

document.getElementById('filter-translated').addEventListener('click', async () => {
  hideTranslated = !hideTranslated;
  document
    .getElementById('filter-translated')
    .classList.toggle('active', hideTranslated);
  await chrome.storage.local.set({ [FILTER_KEY]: hideTranslated });
  renderList();
});

document.getElementById('show-labels').addEventListener('change', async (e) => {
  showLabels = e.target.checked;
  await chrome.storage.local.set({ [SHOW_LABELS_KEY]: showLabels });
});

init();
