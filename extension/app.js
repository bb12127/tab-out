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
  getFolders,
  saveFolders,
  createFolder,
  deleteFolder,
  moveFolderOrder,
  setDomainFolder,
  setDeferredFolder,
  reorderDeferredItem,
} from './storage.js';

import { friendlyDomain, getGreeting, getDateDisplay, timeAgo } from './format.js';

import {
  playCloseSound,
  shootConfetti,
  animateCardOut,
  showToast,
  flipDomainCards,
} from './effects.js';

import {
  escHtml,
  buildLiveWorkspaceMap,
  FOLDER_SVG,
  CHEVRON_DOWN,
  CHEVRON_UP,
  PENCIL_SVG,
  TRASH_SVG,
  ADD_FOLDER_SVG,
  GEAR_SVG,
  folderActionBtns,
  renderDomainCard,
  renderDeferredItem,
  renderArchiveItem,
  renderDeferredGroup,
  renderArchiveGroup,
  renderSavedFolder,
} from './render.js';

import { openIconPicker, closeIconPicker } from './icon-picker.js';


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];

// Opera GX workspace filter — null = "All", otherwise a workspaceId string
let activeWorkspace = null;

// Active folder filter — null = "All", folder id = show only that folder
let activeFolderId = null;

// Whether the folder management panel is open
let _folderManagePanelOpen = false;

// Last-loaded domain→folder map; kept in sync so reorderDomainCard can use it
let _domainFolderMap = {};


/* ----------------------------------------------------------------
   TAB OUT DUPLICATE DETECTION
   ---------------------------------------------------------------- */

async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl   = `chrome-extension://${extensionId}/index.html`;

  const allTabs       = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs    = allTabs.filter(t => t.url === newtabUrl);

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
   FOLDER RENDER HELPERS — these live in app.js because they
   read/write module-level state (activeFolderId, domainGroups,
   _domainFolderMap) or mutate the DOM directly.
   ---------------------------------------------------------------- */

/**
 * reorderDomainCard(domain, dir, folderId)
 *
 * Persists a card reorder within a folder bucket (or root bucket).
 * Uses domainGroups module state to know the current in-folder order.
 */
async function reorderDomainCard(domain, dir, folderId) {
  const { domainFolderOrder = {} } = await chrome.storage.local.get('domainFolderOrder');
  const key      = folderId || '__root__';
  const inFolder = domainGroups
    .filter(g => (_domainFolderMap[g.domain] || null) === (folderId || null))
    .map(g => g.domain);
  let order = (domainFolderOrder[key] || []).filter(d => inFolder.includes(d));
  inFolder.forEach(d => { if (!order.includes(d)) order.push(d); });
  const i = order.indexOf(domain);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  domainFolderOrder[key] = order;
  await chrome.storage.local.set({ domainFolderOrder });
}

/**
 * renderOpenTabsWithFolders(folders, dfMap, domainFolderOrder)
 *
 * Returns HTML for the open-tabs column, with folder section headers,
 * per-folder domain cards, and an "Unfiled" separator at the bottom.
 * Uses module state: domainGroups, activeFolderId.
 */
function renderOpenTabsWithFolders(folders, dfMap, domainFolderOrder) {
  function orderedGroups(folderId) {
    const key  = folderId || '__root__';
    const inF  = domainGroups.filter(g => (dfMap[g.domain] || null) === (folderId || null));
    const saved = (domainFolderOrder[key] || []).filter(d => inF.some(g => g.domain === d));
    const rest  = inF.filter(g => !saved.includes(g.domain));
    return [...saved.map(d => inF.find(g => g.domain === d)), ...rest].filter(Boolean);
  }

  // Folder-focused view — show only cards for the active folder
  if (activeFolderId) {
    const activeFolder = folders.find(f => f.id === activeFolderId);
    const focusHeader = `
      <div class="folder-focus-header">
        <span class="folder-focus-header-name">
          ${FOLDER_SVG}${activeFolder ? escHtml(activeFolder.name) : 'Folder'}
        </span>
        <span class="folder-focus-spacer"></span>
        <button class="folder-focus-clear" data-action="filter-folder" data-folder-id="" title="Back to all tabs">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
          All tabs
        </button>
      </div>`;
    const groups = orderedGroups(activeFolderId);
    if (groups.length === 0) {
      return focusHeader + `<div class="folder-empty-state">No open tabs in this folder yet.<br>Drag a card here or use the folder button on any card.</div>`;
    }
    return focusHeader + groups.map(g => renderDomainCard(g, activeFolderId, dfMap)).join('');
  }

  // "All" view — folder section headers + cards + unfiled
  let html = '';
  const hasFolderCards = folders.some(f => domainGroups.some(g => dfMap[g.domain] === f.id));

  for (const folder of folders) {
    const groups = orderedGroups(folder.id);
    if (groups.length === 0) continue;
    const ago = folder.updatedAt ? timeAgo(folder.updatedAt) : '';
    html += `
      <div class="tab-folder-header-card" data-action="toggle-tab-folder" data-folder-id="${folder.id}">
        <svg class="tab-folder-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
        <span>${FOLDER_SVG}</span>
        <span class="tab-folder-name">${escHtml(folder.name)}</span>
        <span class="tab-folder-count">${groups.length}</span>
        ${ago ? `<span class="tab-folder-updated">${ago}</span>` : ''}
        <div class="tab-folder-actions">${folderActionBtns(folder.id)}</div>
      </div>`;
    for (const g of groups) html += renderDomainCard(g, folder.id, dfMap);
  }

  const unfiled = orderedGroups(null);
  if (unfiled.length > 0 && hasFolderCards) {
    html += `<div class="tab-unfiled-sep"><span class="tab-unfiled-label">Unfiled</span><div class="tab-unfiled-line"></div></div>`;
  }
  for (const g of unfiled) html += renderDomainCard(g, null, dfMap);
  return html;
}

/**
 * renderFolderBar(folders)
 *
 * Writes the folder chip strip into #folderBar. Shows "All" chip +
 * one chip per folder + "New folder" + "Manage" button.
 * Hidden entirely when no folders exist.
 */
function renderFolderBar(folders) {
  const wrap = document.getElementById('folderBarWrap');
  const bar  = document.getElementById('folderBar');
  if (!bar || !wrap) return;

  if (folders.length === 0) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'block';

  const allActive = !activeFolderId ? ' active' : '';
  const ALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"/></svg>`;
  let html = `<button class="folder-chip${allActive}" data-action="filter-folder" data-folder-id="">${ALL_SVG}All</button>`;

  for (const f of folders) {
    const isActive = activeFolderId === f.id;
    html += `<button class="folder-chip${isActive ? ' active' : ''}" data-action="filter-folder" data-folder-id="${escHtml(f.id)}">${FOLDER_SVG}<span class="folder-chip-name">${escHtml(f.name)}</span></button>`;
  }

  html += `<span class="folder-bar-spacer"></span>`;
  html += `<button class="folder-chip-new" data-action="new-folder-bar" title="Create new folder">${ADD_FOLDER_SVG}New folder</button>`;
  html += `<button class="folder-manage-toggle${_folderManagePanelOpen ? ' open' : ''}" data-action="toggle-folder-manage" title="Manage folders">${GEAR_SVG}Manage</button>`;

  bar.innerHTML = html;
}

/**
 * renderFolderManagePanel(folders)
 *
 * Writes the folder management panel (list of all folders with
 * rename/delete/reorder actions) into #folderManagePanel.
 */
function renderFolderManagePanel(folders) {
  const panel = document.getElementById('folderManagePanel');
  if (!panel) return;

  if (!_folderManagePanelOpen || folders.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  let html = `<div class="folder-manage-list">`;
  for (const f of folders) {
    const isActive = activeFolderId === f.id;
    html += `<div class="folder-manage-row${isActive ? ' is-active' : ''}" data-folder-id="${escHtml(f.id)}">
      <span class="folder-manage-icon">${FOLDER_SVG}</span>
      <span class="folder-manage-name">${escHtml(f.name)}</span>
      <div class="folder-manage-btns">
        <button data-action="folder-up"     data-folder-id="${escHtml(f.id)}" title="Move up">${CHEVRON_UP}</button>
        <button data-action="folder-down"   data-folder-id="${escHtml(f.id)}" title="Move down">${CHEVRON_DOWN}</button>
        <button data-action="rename-folder" data-folder-id="${escHtml(f.id)}" title="Rename">${PENCIL_SVG}</button>
        <button class="danger" data-action="delete-folder" data-folder-id="${escHtml(f.id)}" title="Delete">${TRASH_SVG}</button>
      </div>
    </div>`;
  }
  html += `</div>`;
  panel.innerHTML = html;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Respects activeFolderId to filter
 * items when a folder is selected.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');
  const titleEl        = document.getElementById('deferredSectionTitle');

  if (!column) return;

  try {
    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const storedIcons    = await getWorkspaceIconOverrides();
    const liveWorkspaces = buildLiveWorkspaceMap(getOpenTabs());

    // Self-heal workspace renames
    const { itemsChanged, iconsChanged } =
      migrateWorkspaceNames(deferred, storedIcons, liveWorkspaces);
    if (itemsChanged) await chrome.storage.local.set({ deferred });
    if (iconsChanged) await chrome.storage.local.set({ workspaceIcons: storedIcons });

    const visible  = deferred.filter(t => !t.dismissed);
    let   active   = visible.filter(t => !t.completed);
    const archived = visible.filter(t => t.completed);

    // Resolve folder context
    const folders = await getFolders();
    let activeFolderName = null;
    if (activeFolderId) {
      const af = folders.find(f => f.id === activeFolderId);
      activeFolderName = af ? af.name : null;
      active = active.filter(x => x.folderId === activeFolderId);
    }

    if (titleEl) titleEl.textContent = activeFolderName || 'Saved for later';

    // Nothing to show
    if (active.length === 0 && (activeFolderId || archived.length === 0)) {
      if (activeFolderId) {
        // Show empty state for the focused folder
        column.style.display = 'block';
        list.innerHTML = `<div class="folder-empty-state">Nothing saved in this folder yet.</div>`;
        list.style.display = 'block';
        empty.style.display = 'none';
        archiveEl.style.display = 'none';
        countEl.textContent = '';
        return;
      }
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      let html = '';

      if (activeFolderId) {
        // Focused folder — flat list
        html += active.map(item => item.kind === 'group'
          ? renderDeferredGroup(item, storedIcons, liveWorkspaces)
          : renderDeferredItem(item)
        ).join('');
      } else {
        // "All" view — group by folder sections + unfiled
        const hasFolderItems = folders.some(f => active.some(x => x.folderId === f.id));
        for (const folder of folders) {
          const inFolder = active.filter(x => x.folderId === folder.id);
          if (inFolder.length === 0) continue;
          html += renderSavedFolder(folder, inFolder, storedIcons, liveWorkspaces);
        }
        const unfiled = active.filter(x => !x.folderId);
        if (unfiled.length > 0) {
          if (hasFolderItems) {
            html += `<div class="saved-unfiled-sep"><span class="saved-unfiled-label">Unfiled</span><div class="saved-unfiled-line"></div></div>`;
          }
          html += unfiled.map(item => item.kind === 'group'
            ? renderDeferredGroup(item, storedIcons, liveWorkspaces)
            : renderDeferredItem(item)
          ).join('');
        }
      }

      list.innerHTML = html;
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Archive section — hidden when a folder filter is active
    if (archived.length > 0 && !activeFolderId) {
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
 * 3. Groups tabs by domain
 * 4. Renders folder bar + management panel
 * 5. Renders domain cards (respecting folder filter)
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
  const storedIcons = await getWorkspaceIconOverrides();

  const workspaceMap = new Map();
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
  const sortedWorkspaces = [...workspaceMap.entries()].sort(
    (a, b) => a[1].minIndex - b[1].minIndex
  );
  if (activeWorkspace && !workspaceMap.has(activeWorkspace)) {
    activeWorkspace = null;
  }
  const filterEl = document.getElementById('workspaceFilter');
  if (filterEl) {
    if (workspaceMap.size >= 2) {
      const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const iconHtml = (icon) => {
        if (!icon) return '';
        const str = String(icon);
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

  const filteredTabs = activeWorkspace
    ? realTabs.filter(t => t.workspaceId === activeWorkspace)
    : realTabs;

  // --- Group tabs by domain ---
  domainGroups = [];
  const groupMap = {};

  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

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
        return true;
      }) || null;
    } catch { return null; }
  }

  for (const tab of filteredTabs) {
    try {
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

  // Sort by tab count desc; alphabetical tiebreaker for stable order
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const diff = b.tabs.length - a.tabs.length;
    return diff !== 0 ? diff : a.domain.localeCompare(b.domain);
  });

  // --- Load folder data ---
  const [folders, dfMapRaw, { domainFolderOrder = {} }] = await Promise.all([
    getFolders(),
    chrome.storage.local.get('domainFolderMap'),
    chrome.storage.local.get('domainFolderOrder'),
  ]);
  const dfMap = dfMapRaw.domainFolderMap || {};
  _domainFolderMap = dfMap;

  // Render folder bar + management panel
  renderFolderBar(folders);
  renderFolderManagePanel(folders);

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) {
      if (activeFolderId) {
        const af = folders.find(f => f.id === activeFolderId);
        openTabsSectionTitle.textContent = af ? af.name : 'Folder';
      } else {
        openTabsSectionTitle.textContent = 'Open tabs';
      }
    }

    if (activeFolderId) {
      const folderGroups = domainGroups.filter(g => dfMap[g.domain] === activeFolderId);
      const fTabs   = folderGroups.reduce((n, g) => n + g.tabs.length, 0);
      const fDomains = folderGroups.length;
      openTabsSectionCount.textContent = fDomains > 0
        ? `${fDomains} domain${fDomains !== 1 ? 's' : ''} · ${fTabs} tab${fTabs !== 1 ? 's' : ''}`
        : '';
    } else {
      const dCount = domainGroups.length;
      const tCount = filteredTabs.length;
      openTabsSectionCount.textContent =
        `${dCount} domain${dCount !== 1 ? 's' : ''} · ${tCount} tab${tCount !== 1 ? 's' : ''}`;
    }

    const playFlip = flipDomainCards(openTabsMissionsEl);
    openTabsMissionsEl.innerHTML = renderOpenTabsWithFolders(folders, dfMap, domainFolderOrder);
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
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Filter by Opera GX workspace ----
  if (action === 'filter-workspace') {
    const wsId = actionEl.dataset.workspaceId || null;
    if (activeWorkspace === wsId) return;
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
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    suppressAutoRefresh();
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    suppressAutoRefresh();
    const sourceTab = getOpenTabs().find(t => t.url === tabUrl);

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

    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

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

    const { deferred = [] } = await chrome.storage.local.get('deferred');
    const stored = deferred.find(t => t.id === id);
    if (!stored || !stored.url) return;

    const createOpts = { url: stored.url, active: false };
    if (stored.workspaceId != null) createOpts.workspaceId = stored.workspaceId;
    if (stored.windowId    != null) createOpts.windowId    = stored.windowId;
    if (stored.index       != null) createOpts.index       = stored.index;

    let createdTab;
    try {
      createdTab = await chrome.tabs.create(createOpts);
    } catch (err) {
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

    if (stored.workspaceId != null && createdTab && createdTab.workspaceId !== stored.workspaceId) {
      try {
        await chrome.tabs.update(createdTab.id, { workspaceId: stored.workspaceId });
      } catch {}
    }

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
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
    suppressAutoRefresh();
    const directToArchive = action === 'archive-domain-group';
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g =>
      'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId
    );
    if (!group) return;

    const buckets = new Map();
    for (const tab of (group.tabs || [])) {
      const key = tab.workspaceId != null ? tab.workspaceId : '__none__';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(tab);
    }
    const bucketLists = [...buckets.values()].sort((a, b) => {
      const ai = Math.min(...a.map(t => (typeof t.index === 'number') ? t.index : Infinity));
      const bi = Math.min(...b.map(t => (typeof t.index === 'number') ? t.index : Infinity));
      return ai - bi;
    });

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

    const urls     = group.tabs.map(t => t.url);
    const useExact = !!group.label;
    if (useExact) await closeTabsExact(urls);
    else          await closeTabsByUrls(urls);

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const noun       = directToArchive ? 'Archived' : 'Saved';
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
      await dismissGroup(groupId);
      await renderDeferredColumn();
      return;
    }

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
      if (item.workspaceId != null && created && created.workspaceId !== item.workspaceId) {
        try { await chrome.tabs.update(created.id, { workspaceId: item.workspaceId }); }
        catch {}
      }
    }

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
    suppressAutoRefresh();
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g =>
      'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId
    );
    if (!group) return;

    const urls     = group.tabs.map(t => t.url);
    const useExact = !!group.label;

    if (useExact) await closeTabsExact(urls);
    else          await closeTabsByUrls(urls);

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.label || friendlyDomain(group.domain);
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

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
  if (picker.contains(e.target)) return;
  if (e.target.closest('[data-action="open-icon-picker"]')) return;
  closeIconPicker();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeFolderPicker();
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
   FOLDER ACTION HANDLERS — new-folder, rename, delete, reorder,
   toggle-collapse, move-to-folder, deferred/domain reorder
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;

  // ---- Filter by folder (folder bar chip click) ----
  if (act === 'filter-folder') {
    const fid = a.dataset.folderId || null;
    if (activeFolderId === fid) return;
    activeFolderId = fid;
    await renderStaticDashboard();
    return;
  }

  // ---- Create new folder from the folder bar ----
  if (act === 'new-folder-bar') {
    const folder = await createFolder('New Folder');
    _folderManagePanelOpen = true;
    await renderStaticDashboard();
    const nameEl = document.querySelector(`.folder-manage-row[data-folder-id="${folder.id}"] .folder-manage-name`);
    if (nameEl) startFolderRename(nameEl, folder.id);
    return;
  }

  // ---- Toggle folder management panel ----
  if (act === 'toggle-folder-manage') {
    _folderManagePanelOpen = !_folderManagePanelOpen;
    const folders = await getFolders();
    renderFolderManagePanel(folders);
    document.querySelectorAll('[data-action="toggle-folder-manage"]')
      .forEach(btn => btn.classList.toggle('open', _folderManagePanelOpen));
    return;
  }

  // ---- Create new folder (section-level button) ----
  if (act === 'new-folder') {
    const folder = await createFolder('New Folder');
    _folderManagePanelOpen = true;
    await renderStaticDashboard();
    const nameEl = document.querySelector(`.folder-manage-row[data-folder-id="${folder.id}"] .folder-manage-name`);
    if (nameEl) startFolderRename(nameEl, folder.id);
    return;
  }

  // ---- Toggle open-tabs folder collapse ----
  if (act === 'toggle-tab-folder') {
    e.stopPropagation();
    const folderId = a.dataset.folderId;
    a.classList.toggle('collapsed');
    const collapsed = a.classList.contains('collapsed');
    document.querySelectorAll(`.mission-card[data-folder-id="${folderId}"]`)
      .forEach(c => c.classList.toggle('folder-hidden', collapsed));
    return;
  }

  // ---- Toggle saved-column folder collapse ----
  if (act === 'toggle-saved-folder') {
    e.stopPropagation();
    const folder = a.closest('.saved-folder');
    if (folder) folder.classList.toggle('collapsed');
    return;
  }

  // ---- Rename folder ----
  if (act === 'rename-folder') {
    e.stopPropagation();
    const folderId = a.dataset.folderId;
    const nameEl = document.querySelector(
      `.folder-manage-row[data-folder-id="${folderId}"] .folder-manage-name,
       [data-action="toggle-tab-folder"][data-folder-id="${folderId}"] .tab-folder-name,
       [data-action="toggle-saved-folder"][data-folder-id="${folderId}"] .saved-folder-name`
    );
    if (nameEl) startFolderRename(nameEl, folderId);
    return;
  }

  // ---- Delete folder ----
  if (act === 'delete-folder') {
    e.stopPropagation();
    const folderId = a.dataset.folderId;
    if (activeFolderId === folderId) activeFolderId = null;
    await deleteFolder(folderId);
    await renderStaticDashboard();
    showToast('Folder deleted — items moved to unfiled');
    return;
  }

  // ---- Reorder folder up / down ----
  if (act === 'folder-up' || act === 'folder-down') {
    e.stopPropagation();
    const folderId = a.dataset.folderId;
    await moveFolderOrder(folderId, act === 'folder-up' ? 'up' : 'down');
    await renderStaticDashboard();
    return;
  }

  // ---- Move domain card to folder (show picker) ----
  if (act === 'move-domain-to-folder') {
    e.stopPropagation();
    const domain    = a.dataset.domain;
    const currentFo = a.dataset.currentFolder || null;
    const folders   = await getFolders();
    showFolderPicker(a, folders, currentFo, async (folderId) => {
      await setDomainFolder(domain, folderId);
      await renderStaticDashboard();
    });
    return;
  }

  // ---- Move saved item to folder (show picker) ----
  if (act === 'move-saved-to-folder') {
    e.stopPropagation();
    const itemId    = a.dataset.deferredId;
    const currentFo = a.dataset.currentFolder || null;
    const folders   = await getFolders();
    showFolderPicker(a, folders, currentFo, async (folderId) => {
      await setDeferredFolder(itemId, folderId);
      await renderDeferredColumn();
    });
    return;
  }

  // ---- Reorder saved item up / down ----
  if (act === 'deferred-up' || act === 'deferred-down') {
    e.stopPropagation();
    const itemId = a.dataset.deferredId;
    await reorderDeferredItem(itemId, act === 'deferred-up' ? 'up' : 'down');
    await renderDeferredColumn();
    return;
  }

  // ---- Reorder domain card up / down ----
  if (act === 'domain-up' || act === 'domain-down') {
    e.stopPropagation();
    const domain   = a.dataset.domain;
    const folderId = a.dataset.folderId || null;
    await reorderDomainCard(domain, act === 'domain-up' ? 'up' : 'down', folderId || null);
    await renderStaticDashboard();
    return;
  }
});

// ---- Folder picker: close on outside click ----
document.addEventListener('click', (e) => {
  if (!e.target.closest('.folder-picker')) closeFolderPicker();
});


/* ----------------------------------------------------------------
   FOLDER PICKER POPOVER
   ---------------------------------------------------------------- */

let _folderPickerCallback = null;

function showFolderPicker(anchor, folders, currentFolderId, onSelect) {
  closeFolderPicker();
  _folderPickerCallback = onSelect;

  const picker = document.createElement('div');
  picker.className = 'folder-picker';
  picker.id = 'folderPicker';

  const noFolderCls = !currentFolderId ? ' current' : '';
  picker.innerHTML = `
    <button class="folder-picker-item${noFolderCls}" data-pick-folder="">
      <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
      No folder (unfiled)
    </button>
    ${folders.length ? '<div class="folder-picker-sep"></div>' : ''}
    ${folders.map(f => {
      const cls = f.id === currentFolderId ? ' current' : '';
      return `<button class="folder-picker-item${cls}" data-pick-folder="${f.id}">
        ${FOLDER_SVG} ${escHtml(f.name)}
      </button>`;
    }).join('')}`;

  document.body.appendChild(picker);

  const rect = anchor.getBoundingClientRect();
  picker.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
  picker.style.left = (rect.left   + window.scrollX)     + 'px';

  picker.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pick-folder]');
    if (!btn) return;
    const fid = btn.dataset.pickFolder || null;
    closeFolderPicker();
    if (_folderPickerCallback) await _folderPickerCallback(fid);
    _folderPickerCallback = null;
  });
}

function closeFolderPicker() {
  document.getElementById('folderPicker')?.remove();
}


/* ----------------------------------------------------------------
   FOLDER NAME INLINE EDIT
   ---------------------------------------------------------------- */

function startFolderRename(nameEl, folderId) {
  const oldName  = nameEl.textContent.trim();
  const isTab    = nameEl.classList.contains('tab-folder-name');
  const isManage = nameEl.classList.contains('folder-manage-name');
  const cls      = isTab ? 'tab-folder-name-input'
    : isManage   ? 'folder-manage-name-input'
    :              'saved-folder-name-input';

  const input = document.createElement('input');
  input.className = cls;
  input.value     = oldName;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let saved = false;
  async function save() {
    if (saved) return;
    saved = true;
    const newName = input.value.trim() || oldName;
    const folders = await getFolders();
    const f = folders.find(x => x.id === folderId);
    if (f) { f.name = newName; f.updatedAt = Date.now(); await saveFolders(folders); }
    await renderStaticDashboard();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldName; input.blur(); }
  });
  input.addEventListener('blur', save);
}


/* ----------------------------------------------------------------
   DRAG-AND-DROP — move domain cards and saved items into folders
   ---------------------------------------------------------------- */

(function initDragAndDrop() {
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.mission-card[data-domain]');
    if (card) {
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'domain', domain: card.dataset.domain }));
      e.dataTransfer.effectAllowed = 'move';
      return;
    }
    const item = e.target.closest('.deferred-item[data-deferred-id], .deferred-group[data-group-id]');
    if (item) {
      const id = item.dataset.deferredId || item.dataset.groupId;
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'deferred', id }));
      e.dataTransfer.effectAllowed = 'move';
    }
  });

  document.addEventListener('dragover', (e) => {
    const tabHeader   = e.target.closest('.tab-folder-header-card');
    const savedHeader = e.target.closest('.saved-folder-header');
    const target = tabHeader || savedHeader;
    if (!target) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    target.classList.add('drop-target');
  });

  document.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.tab-folder-header-card, .saved-folder-header');
    if (target) target.classList.remove('drop-target');
  });

  document.addEventListener('drop', async (e) => {
    const tabHeader   = e.target.closest('.tab-folder-header-card');
    const savedHeader = e.target.closest('.saved-folder-header');
    const target = tabHeader || savedHeader;
    if (!target) return;
    target.classList.remove('drop-target');
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      const folderId = target.dataset.folderId;
      if (data.type === 'domain' && tabHeader) {
        await setDomainFolder(data.domain, folderId);
        await renderStaticDashboard();
      } else if (data.type === 'deferred' && savedHeader) {
        await setDeferredFolder(data.id, folderId);
        await renderDeferredColumn();
      }
    } catch {}
  });
})();


/* ----------------------------------------------------------------
   GLOBAL SEARCH — filters both columns in real time
   ---------------------------------------------------------------- */

function applySearch(query) {
  const q = query.toLowerCase().trim();
  const wrap = document.getElementById('searchBarWrap');
  if (wrap) wrap.classList.toggle('has-query', q.length > 0);

  // Filter open-tab domain cards
  document.querySelectorAll('.mission-card[data-domain]').forEach(card => {
    const domain = (card.dataset.domain || '').toLowerCase();
    const titles = Array.from(card.querySelectorAll('.chip-text'))
      .map(el => el.textContent.toLowerCase()).join(' ');
    card.style.display = (!q || domain.includes(q) || titles.includes(q)) ? '' : 'none';
  });

  // Show/hide folder headers based on whether they have visible cards
  document.querySelectorAll('.tab-folder-header-card[data-folder-id]').forEach(header => {
    if (!q) { header.style.display = ''; return; }
    const fid = header.dataset.folderId;
    const anyVisible = Array.from(
      document.querySelectorAll(`.mission-card[data-folder-id="${fid}"]`)
    ).some(c => c.style.display !== 'none');
    header.style.display = anyVisible ? '' : 'none';
  });

  // Filter saved items
  document.querySelectorAll('.deferred-item[data-deferred-id]').forEach(item => {
    const title  = (item.querySelector('.deferred-title')?.textContent || '').toLowerCase();
    const domain = (item.querySelector('.deferred-meta span')?.textContent || '').toLowerCase();
    item.style.display = (!q || title.includes(q) || domain.includes(q)) ? '' : 'none';
  });

  document.querySelectorAll('.deferred-group[data-group-id]').forEach(group => {
    const label = (group.querySelector('.group-header-label')?.textContent || '').toLowerCase();
    const texts = Array.from(group.querySelectorAll('.group-item-text'))
      .map(el => el.textContent.toLowerCase()).join(' ');
    group.style.display = (!q || label.includes(q) || texts.includes(q)) ? '' : 'none';
  });

  // Show/hide saved folder wrappers
  document.querySelectorAll('.saved-folder[data-saved-folder-id]').forEach(sf => {
    if (!q) { sf.style.display = ''; return; }
    const anyVisible = Array.from(
      sf.querySelectorAll('.deferred-item, .deferred-group')
    ).some(el => el.style.display !== 'none');
    sf.style.display = anyVisible ? '' : 'none';
  });
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'searchBar') applySearch(e.target.value);
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#searchClearBtn')) {
    const bar = document.getElementById('searchBar');
    if (bar) { bar.value = ''; applySearch(''); }
  }
});


/* ----------------------------------------------------------------
   BROKEN-IMAGE FALLBACK
   ---------------------------------------------------------------- */
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG') {
    el.style.display = 'none';
  }
}, true);


/* ----------------------------------------------------------------
   LIVE TAB SYNC

   Re-render the dashboard when tabs change OUTSIDE Tab Out.
   Debounced so a flurry of events collapses to a single render.
   suppressAutoRefresh() prevents double-renders after user actions
   that already call fetchOpenTabs() directly.
   ---------------------------------------------------------------- */

let __renderDebounceTimer = null;
let __autoRefreshSuppressed = false;
let __autoRefreshSuppressTimer = null;

function suppressAutoRefresh(ms = 1200) {
  __autoRefreshSuppressed = true;
  clearTimeout(__autoRefreshSuppressTimer);
  __autoRefreshSuppressTimer = setTimeout(() => {
    __autoRefreshSuppressed = false;
  }, ms);
}

function scheduleDashboardRefresh(delay = 400) {
  if (__autoRefreshSuppressed) return;
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
