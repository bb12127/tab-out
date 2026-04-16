/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:            t.id,
      url:           t.url,
      title:         t.title,
      windowId:      t.windowId,
      active:        t.active,
      index:         t.index,   // position in the tab strip — used for workspace ordering & tab-restore
      // Opera GX exposes these; other Chromium browsers leave them undefined.
      // No icon field is exposed — workspace icons come from chrome.storage.local
      // and are managed via the in-UI emoji picker (the pencil on each pill).
      workspaceId:   t.workspaceId,
      workspaceName: t.workspaceName,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut:      t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:            Date.now().toString(),
    url:           tab.url,
    title:         tab.title,
    // Remember the Opera GX workspace so restore can put it back where it came
    // from. Older entries lack this and will restore into the active workspace.
    workspaceId:   tab.workspaceId   || null,
    workspaceName: tab.workspaceName || null,
    // Remember the original tab strip position too — restore will try to put
    // the tab back at this index (clamped to current tab count by Chrome).
    index:         (typeof tab.index === 'number') ? tab.index : null,
    windowId:      tab.windowId || null,
    savedAt:       new Date().toISOString(),
    completed:     false,
    dismissed:     false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * restoreArchivedTab(id)
 *
 * Moves an archived (completed) tab back to the active "Saved for Later" list.
 */
async function restoreArchivedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = false;
    delete tab.completedAt;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   GROUPED DEFERRED ENTRIES

   In addition to individual tabs, the 'deferred' storage array can
   also hold "group" entries that bundle multiple tabs saved together
   from a single domain card. Shape:

     {
       id, kind: 'group',
       label, domain,                 // for rendering (favicon lookup etc.)
       savedAt, completedAt?,
       completed, dismissed,          // same lifecycle flags as tabs
       items: [
         { id, url, title,
           workspaceId, workspaceName, index, windowId,
           dismissed }                // per-item flag; group is auto-dismissed
                                      //   when every item is dismissed
       ]
     }

   Legacy individual entries have no `kind` field and are treated as
   kind: 'tab' by the renderer.
   ---------------------------------------------------------------- */

/**
 * saveGroupForLater(group, { directToArchive })
 *
 * Persists a whole domain group (all tabs + per-tab restore metadata)
 * as a single grouped entry in chrome.storage.local.
 */
async function saveGroupForLater(group, options = {}) {
  const { directToArchive = false, baseId = Date.now().toString() } = options;
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const now = new Date().toISOString();
  const label  = group.label || friendlyDomain(group.domain);

  deferred.push({
    id:          baseId,
    kind:        'group',
    label,
    domain:      group.domain,
    savedAt:     now,
    completed:   !!directToArchive,
    completedAt: directToArchive ? now : undefined,
    dismissed:   false,
    items: (group.tabs || []).map((t, i) => ({
      id:            `${baseId}-${i}`,
      url:           t.url,
      title:         t.title,
      workspaceId:   t.workspaceId   || null,
      workspaceName: t.workspaceName || null,
      index:         (typeof t.index === 'number') ? t.index : null,
      windowId:      t.windowId      || null,
      dismissed:     false,
    })),
  });

  await chrome.storage.local.set({ deferred });
}

/**
 * dismissGroupItem(groupId, itemId)
 *
 * Removes a single tab from a saved group. If every tab in the group
 * is now dismissed, the group itself is auto-dismissed too.
 */
async function dismissGroupItem(groupId, itemId) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const group = deferred.find(g => g.id === groupId && g.kind === 'group');
  if (!group) return;
  const item = group.items.find(i => i.id === itemId);
  if (!item) return;
  item.dismissed = true;
  // Auto-dismiss the group when it's empty
  if (group.items.every(i => i.dismissed)) group.dismissed = true;
  await chrome.storage.local.set({ deferred });
}

/**
 * checkOffGroup(groupId) — move a saved group to the archive.
 */
async function checkOffGroup(groupId) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const group = deferred.find(g => g.id === groupId && g.kind === 'group');
  if (!group) return;
  group.completed = true;
  group.completedAt = new Date().toISOString();
  await chrome.storage.local.set({ deferred });
}

/**
 * dismissGroup(groupId) — permanently remove a saved group.
 */
async function dismissGroup(groupId) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const group = deferred.find(g => g.id === groupId && g.kind === 'group');
  if (!group) return;
  group.dismissed = true;
  await chrome.storage.local.set({ deferred });
}

/**
 * restoreArchivedGroup(groupId) — move an archived group back to active saved.
 */
async function restoreArchivedGroup(groupId) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const group = deferred.find(g => g.id === groupId && g.kind === 'group');
  if (!group) return;
  group.completed = false;
  delete group.completedAt;
  await chrome.storage.local.set({ deferred });
}

/**
 * buildLiveWorkspaceMap()
 *
 * Derives a Map<workspaceId, currentWorkspaceName> from the live tab list.
 * Used to (a) self-heal stored workspace names across renames, and (b) detect
 * when a workspace has been deleted so we can flag it in the badge.
 */
function buildLiveWorkspaceMap() {
  const map = new Map();
  for (const t of openTabs) {
    if (t.workspaceId && t.workspaceName && !map.has(t.workspaceId)) {
      map.set(t.workspaceId, t.workspaceName);
    }
  }
  return map;
}

/**
 * migrateWorkspaceNames(deferred, storedIcons, liveWorkspaces)
 *
 * Walks every saved group's items. For any item whose workspaceId is still
 * live but whose stored workspaceName differs, updates the name in-place and
 * moves the user's emoji icon (if any) from the old name key to the new name
 * key in the workspaceIcons map. Returns { itemsChanged, iconsChanged } so the
 * caller can persist to chrome.storage.local only when something actually
 * changed (avoids spurious writes on every render).
 *
 * Skipped entirely when liveWorkspaces is empty (tabs haven't loaded yet —
 * mutating based on an empty map would falsely "delete" everything).
 */
function migrateWorkspaceNames(deferred, storedIcons, liveWorkspaces) {
  if (!liveWorkspaces || liveWorkspaces.size === 0) {
    return { itemsChanged: false, iconsChanged: false };
  }

  const renames = new Map();  // oldName -> newName
  let itemsChanged = false;

  for (const entry of deferred) {
    if (entry.kind !== 'group' || !Array.isArray(entry.items)) continue;
    for (const item of entry.items) {
      if (!item.workspaceId) continue;
      const live = liveWorkspaces.get(item.workspaceId);
      if (!live) continue;                       // workspace deleted — leave name alone
      if (item.workspaceName === live) continue; // no change
      if (item.workspaceName) renames.set(item.workspaceName, live);
      item.workspaceName = live;
      itemsChanged = true;
    }
  }

  let iconsChanged = false;
  for (const [oldName, newName] of renames) {
    if (storedIcons[oldName] && !storedIcons[newName]) {
      storedIcons[newName] = storedIcons[oldName];
      delete storedIcons[oldName];
      iconsChanged = true;
    }
  }

  return { itemsChanged, iconsChanged };
}


/* ----------------------------------------------------------------
   WORKSPACE ICONS — chrome.storage.local

   User-picked workspace emojis live under the 'workspaceIcons' key,
   keyed by workspace NAME (not id, since ids can shift). The in-UI
   picker (pencil on each workspace pill) is the only way to manage them.
   ---------------------------------------------------------------- */

async function getWorkspaceIconOverrides() {
  const { workspaceIcons = {} } = await chrome.storage.local.get('workspaceIcons');
  return workspaceIcons;
}

async function setWorkspaceIconOverride(name, icon) {
  const overrides = await getWorkspaceIconOverrides();
  if (icon) overrides[name] = icon;
  else delete overrides[name];
  await chrome.storage.local.set({ workspaceIcons: overrides });
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title" — that's a browser/page
  // unread badge, not part of the actual page name.
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];

// Opera GX workspace filter — null = "All", otherwise a workspaceId string
let activeWorkspace = null;

// Curated emoji library used by the workspace icon picker.
// Grouped by category; the free-form input below accepts anything else.
const EMOJI_CATEGORIES = [
  { name: 'Work',    emojis: ['💼','📊','📈','📉','💻','🖥️','⌨️','🖨️','📱','📞','✉️','📧','📫','📎','📌','📍','🗂️','📁','📂','📋','📝','✏️','🖊️','📅','📆','🗓️','⏰','⏱️','🔖','💡'] },
  { name: 'Money',   emojis: ['💰','💵','💳','💎','🏦','💹','🧾','🪙'] },
  { name: 'Food',    emojis: ['🍳','🍽️','🍔','🍕','🥗','🍜','🍣','🍱','🥟','🍰','🎂','☕','🍵','🍷','🍺','🥤','🍎','🥐','🍪','🌮','🍿','🥞','🧇','🥙','🥘','🧃'] },
  { name: 'Nature',  emojis: ['🌿','🌱','🌳','🌺','🌸','🌻','🌞','🌙','⭐','🌈','☀️','🔥','💧','🌊','🏔️','⛰️','🏝️','🏖️','🌍','🌵','🍄'] },
  { name: 'Travel',  emojis: ['✈️','🚗','🚕','🚂','🚢','⚓','🚀','🏍️','🚲','🛫','🗺️','🏨','🛣️'] },
  { name: 'Home',    emojis: ['🏠','🏡','🛋️','🛏️','🚪','🧹','🧺','📦','🎁','🔑','🔒','🔨','🛠️','🔧','⚙️','🧰','🧲','🧼','🪑'] },
  { name: 'Play',    emojis: ['🎮','🎨','🎵','🎸','🎹','🎧','📷','🎬','📚','📖','🎯','🎲','🧩','🪁','🎭','🎪','🕹️','🎤'] },
  { name: 'Sport',   emojis: ['🧘','🏃','🚴','🏊','⚽','🏀','🏈','🏐','🎾','🏓','🥊','🥋','🏆','🥇','🏅','⛷️','🏂','🏋️','🤸'] },
  { name: 'Animals', emojis: ['🐶','🐱','🐭','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐷','🐸','🐵','🐔','🦆','🐦','🐧','🐢','🐟','🐳','🦋','🐝','🐙','🦉','🦖'] },
  { name: 'People',  emojis: ['👤','👥','🧠','👁️','👋','👍','👎','✌️','🤝','💪','🫶','🧑‍💻','🧑‍🍳','🧑‍🎨','🧑‍🔬','🧑‍🏫','🧑‍⚕️','🧑‍🔧','🧑‍💼','🧑‍🌾'] },
  { name: 'Heart',   emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💖','💗','💘','💝','💓','💔'] },
  { name: 'Symbol',  emojis: ['✨','💫','⭐','🌟','💥','🔥','⚡','💯','✅','🎉','🎊','❓','❗','💬','🔔','🔕','🎫','🏷️','🔱','♾️','🚧','⚠️','☑️','🆕','🆗','🆒','🔸','🔹','🟢','🟡','🔴','🟣','🟠','⚫','⚪'] },
];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    let tabHostname = '';
    try { tabHostname = new URL(tab.url).hostname; } catch {}
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), tabHostname);
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    // Prefer the tab's own hostname for trailing-site-name stripping
    // (e.g. custom groups use a synthetic key as group.domain).
    let chipHostname = group.domain;
    try { chipHostname = new URL(tab.url).hostname; } catch {}
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), chipHostname);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  const saveIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>`;

  let actionsHtml = `
    <button class="action-btn save-tabs" data-action="save-domain-group" data-domain-id="${stableId}" title="Save all tabs to Saved for Later">
      ${saveIconSvg}
      Save
    </button>
    <button class="action-btn" data-action="archive-domain-group" data-domain-id="${stableId}" title="Archive all tabs (skip the checklist)">
      ${ICONS.archive}
      Archive
    </button>
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${group.label || friendlyDomain(group.domain)}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    // Read the raw deferred list so we can mutate + persist migrations.
    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const storedIcons    = await getWorkspaceIconOverrides();
    const liveWorkspaces = buildLiveWorkspaceMap();

    // Self-heal: if a workspace was renamed, update every saved group's
    // stored name and migrate the emoji icon key. Writes back only when
    // something actually changed.
    const { itemsChanged, iconsChanged } =
      migrateWorkspaceNames(deferred, storedIcons, liveWorkspaces);
    if (itemsChanged) await chrome.storage.local.set({ deferred });
    if (iconsChanged) await chrome.storage.local.set({ workspaceIcons: storedIcons });

    // Derive visible subsets AFTER migration so render sees fresh names.
    const visible  = deferred.filter(t => !t.dismissed);
    const active   = visible.filter(t => !t.completed);
    const archived = visible.filter(t => t.completed);

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items (mix of individual tabs and saved groups)
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active
        .map(item => item.kind === 'group'
          ? renderDeferredGroup(item, storedIcons, liveWorkspaces)
          : renderDeferredItem(item))
        .join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section (mix of individual tabs and archived groups)
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived
        .map(item => item.kind === 'group'
          ? renderArchiveGroup(item, storedIcons, liveWorkspaces)
          : renderArchiveItem(item))
        .join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-restore" data-action="restore-deferred" data-deferred-id="${item.id}" title="Reopen as a tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>
      </button>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item" data-deferred-id="${item.id}">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
      <button class="archive-restore" data-action="restore-archived" data-deferred-id="${item.id}" title="Restore to Saved for Later">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
      </button>
    </div>`;
}

/**
 * buildGroupWorkspaceBadge(group, storedIcons, liveWorkspaces)
 *
 * Inspects the group's non-dismissed items to figure out which Opera GX
 * workspaces they came from. Returns an HTML fragment for the header's meta
 * line.
 *
 *   - single workspace  → "<icon> Name"
 *   - deleted workspace → "Name (deleted)" with muted style (requires
 *                         liveWorkspaces to be populated — otherwise we
 *                         assume the live map is just unavailable and fall
 *                         back to the stored name as-is)
 *   - multiple          → "Name + OtherName"  (icons omitted to save space)
 *   - no workspace info → "" (caller falls back to just the time)
 */
function buildGroupWorkspaceBadge(group, storedIcons = {}, liveWorkspaces = new Map()) {
  const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const liveKnown = liveWorkspaces && liveWorkspaces.size > 0;

  // workspaceId -> { name, isDeleted }
  const seen = new Map();
  for (const item of (group.items || [])) {
    if (item.dismissed) continue;
    if (!item.workspaceId) continue;
    if (seen.has(item.workspaceId)) continue;
    const live = liveWorkspaces.get(item.workspaceId);
    if (live) {
      seen.set(item.workspaceId, { name: live, isDeleted: false });
    } else if (item.workspaceName) {
      // Only flag as deleted when we're confident the live map is authoritative.
      seen.set(item.workspaceId, { name: item.workspaceName, isDeleted: liveKnown });
    }
  }
  if (seen.size === 0) return '';

  const entries = [...seen.values()];
  if (entries.length === 1) {
    const { name, isDeleted } = entries[0];
    const icon = isDeleted ? null : storedIcons[name];
    const iconHtml = icon ? `<span class="group-ws-icon">${escape(icon)}</span>` : '';
    const cls   = isDeleted ? 'group-ws-badge deleted' : 'group-ws-badge';
    const label = isDeleted ? `${escape(name)} (deleted)` : escape(name);
    const title = isDeleted ? `Workspace deleted: ${name}` : `Workspace: ${name}`;
    return `<span class="${cls}" title="${escape(title)}">${iconHtml}${label}</span>`;
  }

  // 2+ workspaces (only possible for legacy saves from before split-by-workspace).
  const joined  = entries.map(e => e.isDeleted ? `${escape(e.name)} (deleted)` : escape(e.name)).join(' + ');
  const tipText = entries.map(e => e.isDeleted ? `${e.name} (deleted)` : e.name).join(', ');
  return `<span class="group-ws-badge multi" title="Workspaces: ${escape(tipText)}">${joined}</span>`;
}

/**
 * renderDeferredGroup(group, storedIcons)
 *
 * Builds HTML for a saved GROUP (many tabs) in the active "Saved for Later"
 * column. Header shows favicon + domain label + item count and three header
 * actions (restore all, check-off-to-archive, dismiss). Body lists each
 * non-dismissed tab with per-item restore + dismiss buttons. Collapsible.
 */
function renderDeferredGroup(group, storedIcons = {}, liveWorkspaces = new Map()) {
  const visibleItems = (group.items || []).filter(i => !i.dismissed);
  const count = visibleItems.length;
  const ago = timeAgo(group.savedAt);
  const faviconUrl = group.domain
    ? `https://www.google.com/s2/favicons?domain=${group.domain}&sz=16`
    : '';
  const safeLabel = (group.label || 'Group').replace(/"/g, '&quot;');
  const wsBadge = buildGroupWorkspaceBadge(group, storedIcons, liveWorkspaces);
  const metaHtml = wsBadge ? `${wsBadge} <span class="group-meta-dot">·</span> ${ago}` : ago;

  const itemsHtml = visibleItems.map(item => {
    const safeTitle = (item.title || item.url || '').replace(/"/g, '&quot;');
    let itemDomain = '';
    try { itemDomain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
    const itemFavicon = itemDomain
      ? `https://www.google.com/s2/favicons?domain=${itemDomain}&sz=16`
      : '';
    return `
      <div class="group-item" data-group-id="${group.id}" data-item-id="${item.id}">
        <a href="${item.url}" target="_blank" rel="noopener" class="group-item-title" title="${safeTitle}">
          ${itemFavicon ? `<img src="${itemFavicon}" alt="" class="group-item-favicon">` : ''}
          <span class="group-item-text">${item.title || item.url}</span>
        </a>
        <button class="deferred-restore" data-action="restore-group-item" data-group-id="${group.id}" data-item-id="${item.id}" title="Reopen as a tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>
        </button>
        <button class="deferred-dismiss" data-action="dismiss-group-item" data-group-id="${group.id}" data-item-id="${item.id}" title="Dismiss">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>`;
  }).join('');

  return `
    <div class="deferred-group" data-group-id="${group.id}">
      <div class="group-header">
        <button class="group-toggle" data-action="toggle-group" data-group-id="${group.id}" title="Expand/collapse">
          <svg class="group-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
        </button>
        <div class="group-header-info">
          <div class="group-header-title" title="${safeLabel}">
            ${faviconUrl ? `<img src="${faviconUrl}" alt="" class="group-header-favicon">` : ''}
            <span class="group-header-label">${group.label || 'Group'}</span>
            <span class="group-header-count">${count} tab${count !== 1 ? 's' : ''}</span>
          </div>
          <div class="group-header-meta">${metaHtml}</div>
        </div>
        <button class="group-header-action" data-action="restore-group-all" data-group-id="${group.id}" title="Reopen all tabs">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>
        </button>
        <button class="group-header-action group-check" data-action="check-group" data-group-id="${group.id}" title="Archive this group">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5" /><path stroke-linecap="round" stroke-linejoin="round" d="M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>
        </button>
        <button class="group-header-action" data-action="dismiss-group" data-group-id="${group.id}" title="Dismiss (delete)">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="group-body">${itemsHtml}</div>
    </div>`;
}

/**
 * renderArchiveGroup(group)
 *
 * Builds HTML for a saved group that's been archived. Header has
 * "Restore all" (opens every tab and dismisses the archive entry) and
 * "Move back to saved". Body has per-item restore + dismiss, identical
 * to the active group body.
 */
function renderArchiveGroup(group, storedIcons = {}, liveWorkspaces = new Map()) {
  const visibleItems = (group.items || []).filter(i => !i.dismissed);
  const count = visibleItems.length;
  const ago = group.completedAt ? timeAgo(group.completedAt) : timeAgo(group.savedAt);
  const faviconUrl = group.domain
    ? `https://www.google.com/s2/favicons?domain=${group.domain}&sz=16`
    : '';
  const safeLabel = (group.label || 'Group').replace(/"/g, '&quot;');
  const wsBadge = buildGroupWorkspaceBadge(group, storedIcons, liveWorkspaces);
  const metaHtml = wsBadge ? `${wsBadge} <span class="group-meta-dot">·</span> ${ago}` : ago;

  const itemsHtml = visibleItems.map(item => {
    const safeTitle = (item.title || item.url || '').replace(/"/g, '&quot;');
    let itemDomain = '';
    try { itemDomain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
    const itemFavicon = itemDomain
      ? `https://www.google.com/s2/favicons?domain=${itemDomain}&sz=16`
      : '';
    return `
      <div class="group-item archived" data-group-id="${group.id}" data-item-id="${item.id}">
        <a href="${item.url}" target="_blank" rel="noopener" class="group-item-title" title="${safeTitle}">
          ${itemFavicon ? `<img src="${itemFavicon}" alt="" class="group-item-favicon">` : ''}
          <span class="group-item-text">${item.title || item.url}</span>
        </a>
        <button class="deferred-restore" data-action="restore-group-item" data-group-id="${group.id}" data-item-id="${item.id}" title="Reopen as a tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>
        </button>
        <button class="deferred-dismiss" data-action="dismiss-group-item" data-group-id="${group.id}" data-item-id="${item.id}" title="Dismiss">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>`;
  }).join('');

  return `
    <div class="deferred-group archived" data-group-id="${group.id}">
      <div class="group-header">
        <button class="group-toggle" data-action="toggle-group" data-group-id="${group.id}" title="Expand/collapse">
          <svg class="group-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
        </button>
        <div class="group-header-info">
          <div class="group-header-title" title="${safeLabel}">
            ${faviconUrl ? `<img src="${faviconUrl}" alt="" class="group-header-favicon">` : ''}
            <span class="group-header-label">${group.label || 'Group'}</span>
            <span class="group-header-count">${count} tab${count !== 1 ? 's' : ''}</span>
          </div>
          <div class="group-header-meta">${metaHtml}</div>
        </div>
        <button class="group-header-action" data-action="restore-group-all" data-group-id="${group.id}" title="Reopen all tabs">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>
        </button>
        <button class="group-header-action" data-action="restore-archived-group" data-group-id="${group.id}" title="Move back to Saved for Later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
        </button>
        <button class="group-header-action" data-action="dismiss-group" data-group-id="${group.id}" title="Dismiss (delete)">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="group-body">${itemsHtml}</div>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Opera GX workspace filter bar ---
  // Workspace icons live entirely in chrome.storage.local, keyed by workspace
  // name. They're managed via the in-UI emoji picker (the pencil on each pill).
  const storedIcons = await getWorkspaceIconOverrides();

  // Collect unique workspaces and remember the smallest tab.index in each, so
  // we can present them in Opera GX's natural sidebar order (workspaces own
  // contiguous ranges of tab indices, so min index ≈ leftmost in the sidebar).
  const workspaceMap = new Map();  // workspaceId -> { name, icon, minIndex }
  for (const t of realTabs) {
    if (!t.workspaceId) continue;
    const name = t.workspaceName || 'Workspace';
    const idx  = typeof t.index === 'number' ? t.index : Number.MAX_SAFE_INTEGER;
    const existing = workspaceMap.get(t.workspaceId);
    if (!existing) {
      workspaceMap.set(t.workspaceId, { name, icon: storedIcons[name] || null, minIndex: idx });
    } else if (idx < existing.minIndex) {
      existing.minIndex = idx;
    }
  }
  // Sort entries by minIndex ascending — leftmost workspace first.
  const sortedWorkspaces = [...workspaceMap.entries()].sort(
    (a, b) => a[1].minIndex - b[1].minIndex
  );
  // Reset filter if the active workspace no longer exists (deleted / all tabs closed).
  if (activeWorkspace && !workspaceMap.has(activeWorkspace)) {
    activeWorkspace = null;
  }
  // Render the filter bar only when there are ≥2 workspaces. Non-Opera browsers
  // return undefined workspaceId, so the Map stays empty and the bar stays hidden.
  const filterEl = document.getElementById('workspaceFilter');
  if (filterEl) {
    if (workspaceMap.size >= 2) {
      const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const iconHtml = (icon) => {
        if (!icon) return '';
        const str = String(icon);
        // If it looks like an image URL, render as <img>; otherwise treat as emoji/text.
        if (/^(https?:|data:|chrome-extension:|\/)/i.test(str)) {
          return `<img class="workspace-btn-icon" src="${escape(str)}" alt="">`;
        }
        return `<span class="workspace-btn-icon">${escape(str)}</span>`;
      };
      const allActive = activeWorkspace === null ? ' active' : '';
      const allBtn = `<button class="workspace-btn${allActive}" data-action="filter-workspace">All</button>`;
      const pencilSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" /></svg>`;
      const wsBtns = sortedWorkspaces.map(([id, ws]) => {
        const activeCls = activeWorkspace === id ? ' active' : '';
        return `<span class="workspace-btn-wrap">
          <button class="workspace-btn${activeCls}" data-action="filter-workspace" data-workspace-id="${escape(id)}">${iconHtml(ws.icon)}${escape(ws.name)}</button>
          <button class="workspace-btn-edit" data-action="open-icon-picker" data-workspace-name="${escape(ws.name)}" title="Change icon">${pencilSvg}</button>
        </span>`;
      }).join('');
      filterEl.innerHTML = allBtn + wsBtns;
      filterEl.style.display = 'flex';
    } else {
      filterEl.style.display = 'none';
      filterEl.innerHTML = '';
    }
  }

  // Apply the workspace filter before grouping — landing-page extraction,
  // custom groups, and domain grouping all flow from filteredTabs.
  const filteredTabs = activeWorkspace
    ? realTabs.filter(t => t.workspaceId === activeWorkspace)
    : realTabs;

  // --- Group tabs by domain ---
  domainGroups = [];
  const groupMap = {};

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of filteredTabs) {
    try {
      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  // Sort by tab count descending — busiest domain first
  domainGroups = Object.values(groupMap).sort((a, b) => b.tabs.length - a.tabs.length);

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    const dCount = domainGroups.length;
    const tCount = filteredTabs.length;
    openTabsSectionCount.textContent =
      `${dCount} domain${dCount !== 1 ? 's' : ''} · ${tCount} tab${tCount !== 1 ? 's' : ''}`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Filter by Opera GX workspace ----
  if (action === 'filter-workspace') {
    const wsId = actionEl.dataset.workspaceId || null;
    if (activeWorkspace === wsId) return;  // already active — no work to do
    activeWorkspace = wsId;
    await renderStaticDashboard();
    return;
  }

  // ---- Open the workspace icon picker ----
  if (action === 'open-icon-picker') {
    e.stopPropagation();
    const name = actionEl.dataset.workspaceName;
    if (!name) return;
    openIconPicker(actionEl, name);
    return;
  }

  // ---- Pick an icon from the grid ----
  if (action === 'pick-icon') {
    e.stopPropagation();
    const picker = document.getElementById('iconPicker');
    const name = picker && picker.dataset.workspaceName;
    const icon = actionEl.dataset.icon;
    if (!name || !icon) return;
    await setWorkspaceIconOverride(name, icon);
    closeIconPicker();
    await renderStaticDashboard();
    return;
  }

  // ---- Clear the current workspace's icon override ----
  if (action === 'clear-icon') {
    e.stopPropagation();
    const picker = document.getElementById('iconPicker');
    const name = picker && picker.dataset.workspaceName;
    if (!name) return;
    await setWorkspaceIconOverride(name, null);
    closeIconPicker();
    await renderStaticDashboard();
    return;
  }

  // ---- Close the picker via its X ----
  if (action === 'close-icon-picker') {
    e.stopPropagation();
    closeIconPicker();
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const parent = actionEl.parentElement;
    if (!parent) return;
    const overflowContainer = parent.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // The chrome.tabs.onRemoved listener will auto-refresh the section count.
    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Find the source tab so we can remember its Opera GX workspace + position
    const sourceTab = openTabs.find(t => t.url === tabUrl);

    // Save to chrome.storage.local
    try {
      await saveTabForLater({
        url:           tabUrl,
        title:         tabTitle,
        workspaceId:   sourceTab && sourceTab.workspaceId,
        workspaceName: sourceTab && sourceTab.workspaceName,
        index:         sourceTab && sourceTab.index,
        windowId:      sourceTab && sourceTab.windowId,
      });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Restore a saved-for-later tab back to the browser ----
  if (action === 'restore-deferred') {
    e.stopPropagation();
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    // Pull the full record from storage so we get url + workspace + position together
    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const stored = deferred.find(t => t.id === id);
    if (!stored || !stored.url) return;

    // Build create options. Only include each field if we know it — undefined
    // would shadow Chrome's defaults.
    const createOpts = { url: stored.url, active: false };
    if (stored.workspaceId != null) createOpts.workspaceId = stored.workspaceId;
    if (stored.windowId    != null) createOpts.windowId    = stored.windowId;
    if (stored.index       != null) createOpts.index       = stored.index;

    let createdTab;
    try {
      createdTab = await chrome.tabs.create(createOpts);
    } catch (err) {
      // windowId may have closed since save — retry without it
      if (createOpts.windowId != null) {
        try {
          delete createOpts.windowId;
          createdTab = await chrome.tabs.create(createOpts);
        } catch (err2) {
          console.error('[tab-out] Failed to reopen tab:', err2);
          showToast('Could not reopen tab');
          return;
        }
      } else {
        console.error('[tab-out] Failed to reopen tab:', err);
        showToast('Could not reopen tab');
        return;
      }
    }

    // If a workspace was requested but didn't stick at creation, patch it on.
    // Some Opera GX builds need workspaceId via tabs.update rather than create.
    if (stored.workspaceId != null && createdTab && createdTab.workspaceId !== stored.workspaceId) {
      try {
        await chrome.tabs.update(createdTab.id, { workspaceId: stored.workspaceId });
      } catch {
        // Older Opera GX may not support workspaceId on update — tab still opens.
      }
    }

    // Now that the tab is open, remove it from the saved-for-later list
    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
        renderStaticDashboard();
      }, 300);
    } else {
      await renderStaticDashboard();
    }

    showToast('Reopened as a tab');
    return;
  }

  // ---- Save the whole domain group for later (active checklist) ----
  if (action === 'save-domain-group' || action === 'archive-domain-group') {
    const directToArchive = action === 'archive-domain-group';
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g =>
      'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId
    );
    if (!group) return;

    // Split tabs by Opera GX workspaceId so each workspace becomes its OWN
    // saved group — makes it obvious which domain tabs came from which
    // workspace when reviewing later. Tabs with no workspaceId (e.g. non-Opera)
    // share a single bucket.
    const buckets = new Map();
    for (const tab of (group.tabs || [])) {
      const key = tab.workspaceId != null ? tab.workspaceId : '__none__';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(tab);
    }
    // Preserve Opera GX sidebar ordering — bucket with the smallest tab
    // index ends up first in the saved list.
    const bucketLists = [...buckets.values()].sort((a, b) => {
      const ai = Math.min(...a.map(t => (typeof t.index === 'number') ? t.index : Infinity));
      const bi = Math.min(...b.map(t => (typeof t.index === 'number') ? t.index : Infinity));
      return ai - bi;
    });

    // Persist each bucket as its own group so renderDeferredGroup later
    // shows one card per workspace with a clean single-workspace badge.
    const saveStart = Date.now();
    try {
      for (let i = 0; i < bucketLists.length; i++) {
        await saveGroupForLater(
          { ...group, tabs: bucketLists[i] },
          { directToArchive, baseId: `${saveStart}-${i}` }
        );
      }
    } catch (err) {
      console.error('[tab-out] Failed to save group:', err);
      showToast('Failed to save group');
      return;
    }

    // Close the browser tabs (reuse the same close rules as close-domain-tabs)
    const urls     = group.tabs.map(t => t.url);
    // Custom groups (label set) match exact URLs because their synthetic
    // group key isn't a real hostname. Regular domain groups match by hostname.
    const useExact = !!group.label;
    if (useExact) await closeTabsExact(urls);
    else          await closeTabsByUrls(urls);

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups so the card doesn't resurrect on next render
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const noun = directToArchive ? 'Archived' : 'Saved';
    const groupLabel = group.label || friendlyDomain(group.domain);
    const suffix     = bucketLists.length > 1 ? ` across ${bucketLists.length} workspaces` : '';
    showToast(`${noun} ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}${suffix}`);

    await renderDeferredColumn();
    return;
  }

  // ---- Toggle a saved group's expand/collapse state ----
  if (action === 'toggle-group') {
    const groupEl = actionEl.closest('.deferred-group');
    if (groupEl) groupEl.classList.toggle('collapsed');
    return;
  }

  // ---- Restore all tabs in a saved group (active OR archived) ----
  if (action === 'restore-group-all') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId) return;

    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const group = deferred.find(g => g.id === groupId && g.kind === 'group');
    if (!group) return;

    const items = (group.items || []).filter(i => !i.dismissed);
    if (items.length === 0) {
      // Nothing left to restore — just dismiss the now-empty group
      await dismissGroup(groupId);
      await renderDeferredColumn();
      return;
    }

    // Restore every tab in its original workspace / index / window (best-effort).
    // Sort by index ascending so inserts land in a predictable order.
    const sorted = [...items].sort((a, b) =>
      (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER)
    );
    for (const item of sorted) {
      const createOpts = { url: item.url, active: false };
      if (item.workspaceId != null) createOpts.workspaceId = item.workspaceId;
      if (item.windowId    != null) createOpts.windowId    = item.windowId;
      if (item.index       != null) createOpts.index       = item.index;
      let created;
      try {
        created = await chrome.tabs.create(createOpts);
      } catch {
        // windowId may have closed — retry without it
        if (createOpts.windowId != null) {
          try {
            delete createOpts.windowId;
            created = await chrome.tabs.create(createOpts);
          } catch (err2) {
            console.error('[tab-out] Could not reopen', item.url, err2);
            continue;
          }
        } else {
          console.error('[tab-out] Could not reopen', item.url);
          continue;
        }
      }
      // Patch workspaceId if the create didn't honor it
      if (item.workspaceId != null && created && created.workspaceId !== item.workspaceId) {
        try { await chrome.tabs.update(created.id, { workspaceId: item.workspaceId }); }
        catch {}
      }
    }

    // All tabs are open — dismiss the saved group entirely
    await dismissGroup(groupId);
    showToast(`Reopened ${items.length} tab${items.length !== 1 ? 's' : ''}`);
    await renderDeferredColumn();
    await renderStaticDashboard();
    return;
  }

  // ---- Restore one item from a saved group ----
  if (action === 'restore-group-item') {
    const groupId = actionEl.dataset.groupId;
    const itemId  = actionEl.dataset.itemId;
    if (!groupId || !itemId) return;

    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const group = deferred.find(g => g.id === groupId && g.kind === 'group');
    if (!group) return;
    const item = group.items.find(i => i.id === itemId);
    if (!item || item.dismissed) return;

    const createOpts = { url: item.url, active: false };
    if (item.workspaceId != null) createOpts.workspaceId = item.workspaceId;
    if (item.windowId    != null) createOpts.windowId    = item.windowId;
    if (item.index       != null) createOpts.index       = item.index;

    let created;
    try {
      created = await chrome.tabs.create(createOpts);
    } catch {
      if (createOpts.windowId != null) {
        try {
          delete createOpts.windowId;
          created = await chrome.tabs.create(createOpts);
        } catch (err2) {
          console.error('[tab-out] Could not reopen', item.url, err2);
          showToast('Could not reopen tab');
          return;
        }
      } else {
        console.error('[tab-out] Could not reopen', item.url);
        showToast('Could not reopen tab');
        return;
      }
    }
    if (item.workspaceId != null && created && created.workspaceId !== item.workspaceId) {
      try { await chrome.tabs.update(created.id, { workspaceId: item.workspaceId }); }
      catch {}
    }

    // Mark the item dismissed; auto-dismiss the group if it's now empty
    await dismissGroupItem(groupId, itemId);

    const itemRow = actionEl.closest('.group-item');
    if (itemRow) {
      itemRow.classList.add('removing');
      setTimeout(() => {
        itemRow.remove();
        renderDeferredColumn();
        renderStaticDashboard();
      }, 250);
    } else {
      await renderDeferredColumn();
      await renderStaticDashboard();
    }

    showToast('Reopened as a tab');
    return;
  }

  // ---- Dismiss one item from a saved group (without opening it) ----
  if (action === 'dismiss-group-item') {
    const groupId = actionEl.dataset.groupId;
    const itemId  = actionEl.dataset.itemId;
    if (!groupId || !itemId) return;

    await dismissGroupItem(groupId, itemId);

    const itemRow = actionEl.closest('.group-item');
    if (itemRow) {
      itemRow.classList.add('removing');
      setTimeout(() => {
        itemRow.remove();
        renderDeferredColumn();
      }, 250);
    } else {
      await renderDeferredColumn();
    }
    return;
  }

  // ---- Check off a saved group (move to archive) ----
  if (action === 'check-group') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId) return;
    await checkOffGroup(groupId);
    showToast('Group archived');
    await renderDeferredColumn();
    return;
  }

  // ---- Dismiss an entire saved group (delete it) ----
  if (action === 'dismiss-group') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId) return;
    await dismissGroup(groupId);

    const groupEl = actionEl.closest('.deferred-group');
    if (groupEl) {
      groupEl.classList.add('removing');
      setTimeout(() => {
        groupEl.remove();
        renderDeferredColumn();
      }, 250);
    } else {
      await renderDeferredColumn();
    }
    return;
  }

  // ---- Move an archived group back to active Saved for Later ----
  if (action === 'restore-archived-group') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId) return;
    await restoreArchivedGroup(groupId);
    showToast('Restored to Saved for Later');
    await renderDeferredColumn();
    return;
  }

  // ---- Restore an archived tab back to active "Saved for Later" ----
  if (action === 'restore-archived') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await restoreArchivedTab(id);

    const item = actionEl.closest('.archive-item');
    if (item) {
      item.style.transition = 'opacity 0.25s, transform 0.25s';
      item.style.opacity    = '0';
      item.style.transform  = 'translateX(-10px)';
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 250);
    } else {
      await renderDeferredColumn();
    }

    showToast('Restored to Saved for Later');
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls     = group.tabs.map(t => t.url);
    // Custom groups (label set) use a synthetic key as group.domain so we
    // have to match by exact URL. Regular domain groups match by hostname.
    const useExact = !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.label || friendlyDomain(group.domain);
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    // The chrome.tabs.onRemoved listener will auto-refresh the section count.
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Icon picker: click-outside closes it, Escape closes it ----
document.addEventListener('click', (e) => {
  const picker = document.getElementById('iconPicker');
  if (!picker || picker.style.display === 'none') return;
  if (picker.contains(e.target)) return;                // click inside picker — fine
  if (e.target.closest('[data-action="open-icon-picker"]')) return; // opening click — fine
  closeIconPicker();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const picker = document.getElementById('iconPicker');
  if (picker && picker.style.display !== 'none') closeIconPicker();
});

// ---- Icon picker: free-form input (accepts any emoji / paste / Win+.) ----
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'iconPickerInput') return;
  const picker = document.getElementById('iconPicker');
  const name = picker && picker.dataset.workspaceName;
  const value = (e.target.value || '').trim();
  if (!name || !value) return;
  await setWorkspaceIconOverride(name, value);
  closeIconPicker();
  await renderStaticDashboard();
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();
    const storedIcons    = await getWorkspaceIconOverrides();
    const liveWorkspaces = buildLiveWorkspaceMap();
    const renderEntry = (item) =>
      item.kind === 'group'
        ? renderArchiveGroup(item, storedIcons, liveWorkspaces)
        : renderArchiveItem(item);

    if (q.length < 2) {
      archiveList.innerHTML = archived.map(renderEntry).join('');
      return;
    }

    // Match individual tabs by title/url. Match groups by label OR by any
    // non-dismissed item inside the group matching title/url.
    const results = archived.filter(item => {
      if (item.kind === 'group') {
        if ((item.label || '').toLowerCase().includes(q)) return true;
        return (item.items || []).some(i =>
          !i.dismissed && (
            (i.title || '').toLowerCase().includes(q) ||
            (i.url   || '').toLowerCase().includes(q)
          )
        );
      }
      return (item.title || '').toLowerCase().includes(q) ||
             (item.url   || '').toLowerCase().includes(q);
    });

    archiveList.innerHTML = results.map(renderEntry).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   WORKSPACE ICON PICKER — render + position + close

   Popover anchored to the clicked workspace's edit pencil. Contents
   are built from EMOJI_CATEGORIES plus a free-form input so any emoji
   (e.g. from Windows' Win+. picker) can be used.
   ---------------------------------------------------------------- */

function openIconPicker(anchorEl, workspaceName) {
  const picker = document.getElementById('iconPicker');
  if (!picker || !anchorEl) return;

  const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeName = escape(workspaceName);

  const categoriesHtml = EMOJI_CATEGORIES.map(cat => {
    const options = cat.emojis.map(e =>
      `<button class="icon-picker-option" data-action="pick-icon" data-icon="${escape(e)}" title="${escape(e)}">${escape(e)}</button>`
    ).join('');
    return `<div class="icon-picker-section">
      <div class="icon-picker-section-label">${escape(cat.name)}</div>
      <div class="icon-picker-grid">${options}</div>
    </div>`;
  }).join('');

  picker.dataset.workspaceName = workspaceName;
  picker.innerHTML = `
    <div class="icon-picker-header">
      <span>Pick an icon for <strong>${safeName}</strong></span>
      <button class="icon-picker-close" data-action="close-icon-picker" title="Close">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="icon-picker-body">${categoriesHtml}</div>
    <div class="icon-picker-footer">
      <input type="text" class="icon-picker-input" id="iconPickerInput" placeholder="Or paste / type any emoji (Win+. on Windows)" maxlength="8">
      <button class="icon-picker-clear" data-action="clear-icon">Clear</button>
    </div>
  `;

  // Show first so offsetWidth/Height are real, then position.
  picker.style.display = 'block';
  picker.style.visibility = 'hidden';

  const anchorRect = anchorEl.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  const margin = 8;

  let top = anchorRect.bottom + window.scrollY + 6;
  let left = anchorRect.left + window.scrollX;

  // Keep inside viewport horizontally
  const maxLeft = window.scrollX + document.documentElement.clientWidth - pickerRect.width - margin;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;

  // If it would overflow the bottom, flip above the anchor
  const viewportBottom = window.scrollY + document.documentElement.clientHeight;
  if (top + pickerRect.height + margin > viewportBottom) {
    top = anchorRect.top + window.scrollY - pickerRect.height - 6;
    if (top < window.scrollY + margin) top = window.scrollY + margin;
  }

  picker.style.top  = top + 'px';
  picker.style.left = left + 'px';
  picker.style.visibility = 'visible';

  // Autofocus the free-form input so Win+. / paste works immediately
  const input = document.getElementById('iconPickerInput');
  if (input) input.focus();
}

function closeIconPicker() {
  const picker = document.getElementById('iconPicker');
  if (!picker) return;
  picker.style.display = 'none';
  picker.innerHTML = '';
  delete picker.dataset.workspaceName;
}


/* ----------------------------------------------------------------
   BROKEN-IMAGE FALLBACK

   Extensions have strict CSP that disallows inline event handlers
   like onerror="...", so we handle image-load failures globally.
   `error` events don't bubble — use a capturing listener instead.
   ---------------------------------------------------------------- */
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG') {
    el.style.display = 'none';
  }
}, true);


/* ----------------------------------------------------------------
   LIVE TAB SYNC

   Re-render the dashboard when tabs change OUTSIDE Tab Out (open / close /
   move / navigate in another window). Debounced so a flurry of events
   (e.g. closing many tabs at once) collapses to a single render.
   ---------------------------------------------------------------- */

let __renderDebounceTimer = null;
function scheduleDashboardRefresh(delay = 400) {
  if (__renderDebounceTimer) clearTimeout(__renderDebounceTimer);
  __renderDebounceTimer = setTimeout(() => {
    __renderDebounceTimer = null;
    renderStaticDashboard();
  }, delay);
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onCreated.addListener(() => scheduleDashboardRefresh());
  chrome.tabs.onRemoved.addListener(() => scheduleDashboardRefresh());
  chrome.tabs.onMoved.addListener(()   => scheduleDashboardRefresh());
  chrome.tabs.onAttached.addListener(() => scheduleDashboardRefresh());
  chrome.tabs.onDetached.addListener(() => scheduleDashboardRefresh());
  // onUpdated fires for every loading-progress tick — only refresh on
  // changes that actually affect what we display (URL, title, completion).
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
      scheduleDashboardRefresh();
    }
  });
}


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
