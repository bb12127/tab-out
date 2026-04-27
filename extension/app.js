/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   Module layout (loaded via <script type="module"> in index.html):
     ./tabs.js         — chrome.tabs/windows wrappers + openTabs snapshot
     ./storage.js      — chrome.storage.local CRUD + workspace migration
     ./format.js       — pure string/date helpers
     ./effects.js      — audio, confetti, FLIP, toast, empty-state
     ./render.js       — HTML string builders
     ./icon-picker.js  — workspace emoji picker popover
     ./app.js          — render orchestration + event handlers + init (this file)

   What this file does:
   1. Renders the static dashboard (greeting, tabs grouped by domain, deferred column)
   2. Wires up the document-level event delegation for all UI actions
   3. Listens to chrome.tabs.* events and debounces re-renders
   ================================================================ */

'use strict';

import {
  fetchOpenTabs,
  getOpenTabs,
  getRealTabs,
  closeTabsByUrls,
  closeTabsExact,
  focusTab,
  closeDuplicateTabs,
} from './tabs.js';

import {
  saveTabForLater,
  getSavedTabs,
  dismissSavedTab,
  restoreArchivedTab,
  saveGroupForLater,
  dismissGroupItem,
  checkOffGroup,
  dismissGroup,
  restoreArchivedGroup,
  migrateWorkspaceNames,
  getWorkspaceIconOverrides,
  setWorkspaceIconOverride,
} from './storage.js';

import { friendlyDomain, getGreeting, getDateDisplay } from './format.js';

import {
  playCloseSound,
  shootConfetti,
  animateCardOut,
  showToast,
  flipDomainCards,
} from './effects.js';

import {
  buildLiveWorkspaceMap,
  renderDomainCard,
  renderDeferredItem,
  renderArchiveItem,
  renderDeferredGroup,
  renderArchiveGroup,
} from './render.js';

import { openIconPicker, closeIconPicker } from './icon-picker.js';


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS

   These two are the orchestrator's state — they're read by the
   render pipeline below and read/written by the click handler.
   ---------------------------------------------------------------- */
let domainGroups = [];

// Opera GX workspace filter — null = "All", otherwise a workspaceId string
let activeWorkspace = null;


/* ----------------------------------------------------------------
   TAB OUT DUPLICATE DETECTION

   When the user opens multiple new tabs, each one is a separate
   instance of this dashboard. The banner offers to close the extras.
   ---------------------------------------------------------------- */

async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl   = `chrome-extension://${extensionId}/index.html`;

  const allTabs      = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs   = allTabs.filter(t => t.url === newtabUrl);

  if (tabOutTabs.length <= 1) return;

  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

function checkTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl   = `chrome-extension://${extensionId}/index.html`;
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  chrome.tabs.query({}).then(allTabs => {
    const tabOutTabs = allTabs.filter(t => t.url === newtabUrl);
    if (tabOutTabs.length > 1) {
      if (countEl) countEl.textContent = tabOutTabs.length;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  });
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
    const liveWorkspaces = buildLiveWorkspaceMap(getOpenTabs());

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

  // Custom group rules from config.local.js (if any). The file is gitignored
  // and not loaded by index.html by default — users can wire it up themselves.
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
    const playFlip = flipDomainCards(openTabsMissionsEl);
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    playFlip();
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
    const sourceTab = getOpenTabs().find(t => t.url === tabUrl);

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
    const liveWorkspaces = buildLiveWorkspaceMap(getOpenTabs());
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
