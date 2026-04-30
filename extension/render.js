/* ================================================================
   render.js — HTML string builders

   Pure functions that turn data into HTML strings. No chrome.* APIs,
   no DOM mutation, no module state. The orchestrator (app.js) calls
   these and writes the returned strings into innerHTML.
   ================================================================ */

'use strict';

import {
  friendlyDomain,
  cleanTitle,
  smartTitle,
  stripTitleNoise,
  timeAgo,
} from './format.js';


/* ----------------------------------------------------------------
   UTILITY
   ---------------------------------------------------------------- */

export const escHtml = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');


/* ----------------------------------------------------------------
   FOLDER SVG CONSTANTS
   ---------------------------------------------------------------- */

export const FOLDER_SVG    = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v8.25A2.25 2.25 0 0 0 4.5 16.5h15a2.25 2.25 0 0 0 2.25-2.25V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"/></svg>`;
export const CHEVRON_DOWN  = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>`;
export const CHEVRON_UP    = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5"/></svg>`;
export const PENCIL_SVG    = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z"/></svg>`;
export const TRASH_SVG     = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>`;
export const ADD_FOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>`;
export const GEAR_SVG      = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94H9.75c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>`;

/**
 * folderActionBtns(folderId)
 *
 * Returns up/down/rename/delete action buttons for a folder header row.
 */
export function folderActionBtns(folderId) {
  return `
    <button class="tab-folder-btn" data-action="folder-up"     data-folder-id="${folderId}" title="Move folder up">${CHEVRON_UP}</button>
    <button class="tab-folder-btn" data-action="folder-down"   data-folder-id="${folderId}" title="Move folder down">${CHEVRON_DOWN}</button>
    <button class="tab-folder-btn" data-action="rename-folder" data-folder-id="${folderId}" title="Rename">${PENCIL_SVG}</button>
    <button class="tab-folder-btn danger" data-action="delete-folder" data-folder-id="${folderId}" title="Delete folder">${TRASH_SVG}</button>`;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS — used across renderers
   ---------------------------------------------------------------- */
export const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>`,
};


/* ----------------------------------------------------------------
   buildLiveWorkspaceMap(openTabs)

   Derives a Map<workspaceId, currentWorkspaceName> from the live tab
   list. Used to (a) self-heal stored workspace names across renames,
   and (b) detect when a workspace has been deleted so we can flag it
   in the badge.
   ---------------------------------------------------------------- */
export function buildLiveWorkspaceMap(openTabs) {
  const map = new Map();
  for (const t of openTabs) {
    if (t.workspaceId && t.workspaceName && !map.has(t.workspaceId)) {
      map.set(t.workspaceId, t.workspaceName);
    }
  }
  return map;
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

export function buildOverflowChips(hiddenTabs, urlCounts = {}) {
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
 * renderDomainCard(group, folderId, domainFolderMap)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 * folderId       — the folder this card belongs to (null = unfiled)
 * domainFolderMap — full domain→folderId map (for future use)
 */
export function renderDomainCard(group, folderId = null, domainFolderMap = {}) {
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
    <button class="action-btn archive-tabs" data-action="archive-domain-group" data-domain-id="${stableId}" title="Archive all tabs (skip the checklist)">
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

  // Folder row — move-to-folder button + card reorder buttons
  const currentFolderId = folderId || null;
  const folderBtnClass  = currentFolderId ? ' in-folder' : '';
  const upSvg   = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5"/></svg>`;
  const downSvg = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>`;

  const folderRow = `
    <div style="display:flex;align-items:center;gap:4px;margin-top:8px">
      <button class="move-folder-btn${folderBtnClass}" data-action="move-domain-to-folder"
        data-domain="${group.domain}" data-current-folder="${escHtml(currentFolderId || '')}"
        title="Move to folder">${FOLDER_SVG}</button>
      <div class="card-reorder-btns">
        <button class="card-reorder-btn" data-action="domain-up"
          data-domain="${group.domain}" data-folder-id="${escHtml(currentFolderId || '')}"
          title="Move card up">${upSvg}</button>
        <button class="card-reorder-btn" data-action="domain-down"
          data-domain="${group.domain}" data-folder-id="${escHtml(currentFolderId || '')}"
          title="Move card down">${downSvg}</button>
      </div>
    </div>`;

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}"
         data-domain-id="${stableId}" data-domain="${group.domain}"
         data-folder-id="${escHtml(currentFolderId || '')}"
         draggable="true">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${group.label || friendlyDomain(group.domain)}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
        ${folderRow}
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — item / group renderers
   ---------------------------------------------------------------- */

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
export function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const savedAgo   = timeAgo(item.savedAt);
  const changedAgo = item.updatedAt ? timeAgo(item.updatedAt) : null;
  const folderCls  = item.folderId ? ' in-folder' : '';

  return `
    <div class="deferred-item" data-deferred-id="${item.id}" draggable="true">
      <div class="reorder-btns">
        <button class="reorder-btn" data-action="deferred-up" data-deferred-id="${item.id}" title="Move up">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5"/></svg>
        </button>
        <button class="reorder-btn" data-action="deferred-down" data-deferred-id="${item.id}" title="Move down">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
        </button>
      </div>
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${changedAgo ? 'changed ' + changedAgo : savedAgo}</span>
        </div>
      </div>
      <button class="item-folder-btn${folderCls}" data-action="move-saved-to-folder"
        data-deferred-id="${item.id}" data-current-folder="${escHtml(item.folderId || '')}"
        title="Move to folder">${FOLDER_SVG}</button>
      <button class="deferred-restore" data-action="restore-deferred" data-deferred-id="${item.id}" title="Reopen as a tab">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
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
export function renderArchiveItem(item) {
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
export function buildGroupWorkspaceBadge(group, storedIcons = {}, liveWorkspaces = new Map()) {
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
    const iconHtml = icon ? `<span class="group-ws-icon">${escHtml(icon)}</span>` : '';
    const cls   = isDeleted ? 'group-ws-badge deleted' : 'group-ws-badge';
    const label = isDeleted ? `${escHtml(name)} (deleted)` : escHtml(name);
    const title = isDeleted ? `Workspace deleted: ${name}` : `Workspace: ${name}`;
    return `<span class="${cls}" title="${escHtml(title)}">${iconHtml}${label}</span>`;
  }

  // 2+ workspaces (only possible for legacy saves from before split-by-workspace).
  const joined  = entries.map(e => e.isDeleted ? `${escHtml(e.name)} (deleted)` : escHtml(e.name)).join(' + ');
  const tipText = entries.map(e => e.isDeleted ? `${e.name} (deleted)` : e.name).join(', ');
  return `<span class="group-ws-badge multi" title="Workspaces: ${escHtml(tipText)}">${joined}</span>`;
}

/**
 * renderDeferredGroup(group, storedIcons)
 *
 * Builds HTML for a saved GROUP (many tabs) in the active "Saved for Later"
 * column. Header shows favicon + domain label + item count and three header
 * actions (restore all, check-off-to-archive, dismiss). Body lists each
 * non-dismissed tab with per-item restore + dismiss buttons. Collapsible.
 */
export function renderDeferredGroup(group, storedIcons = {}, liveWorkspaces = new Map()) {
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
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
        </button>
        <button class="deferred-dismiss" data-action="dismiss-group-item" data-group-id="${group.id}" data-item-id="${item.id}" title="Dismiss">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>`;
  }).join('');

  const folderCls  = group.folderId ? ' in-folder' : '';
  const changedAgo = group.updatedAt ? timeAgo(group.updatedAt) : null;

  return `
    <div class="deferred-group" data-group-id="${group.id}" draggable="true">
      <div class="group-header">
        <div class="reorder-btns">
          <button class="reorder-btn" data-action="deferred-up" data-deferred-id="${group.id}" title="Move up">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5"/></svg>
          </button>
          <button class="reorder-btn" data-action="deferred-down" data-deferred-id="${group.id}" title="Move down">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
          </button>
        </div>
        <button class="group-toggle" data-action="toggle-group" data-group-id="${group.id}" title="Expand/collapse">
          <svg class="group-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
        </button>
        <div class="group-header-info">
          <div class="group-header-title" title="${safeLabel}">
            ${faviconUrl ? `<img src="${faviconUrl}" alt="" class="group-header-favicon">` : ''}
            <span class="group-header-label">${group.label || 'Group'}</span>
            <span class="group-header-count">${count} tab${count !== 1 ? 's' : ''}</span>
          </div>
          <div class="group-header-meta">${changedAgo ? 'changed ' + changedAgo + ' · ' : ''}${metaHtml}</div>
        </div>
        <button class="item-folder-btn${folderCls}" data-action="move-saved-to-folder"
          data-deferred-id="${group.id}" data-current-folder="${escHtml(group.folderId || '')}"
          title="Move to folder">${FOLDER_SVG}</button>
        <button class="group-header-action" data-action="restore-group-all" data-group-id="${group.id}" title="Reopen all tabs">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
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
export function renderArchiveGroup(group, storedIcons = {}, liveWorkspaces = new Map()) {
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
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
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
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
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
   SAVED FOLDER SECTION RENDERER
   ---------------------------------------------------------------- */

/**
 * renderSavedFolder(folder, items, storedIcons, liveWorkspaces)
 *
 * Renders a collapsible section in the "Saved for Later" column for
 * items that belong to a named folder.
 */
export function renderSavedFolder(folder, items, storedIcons = {}, liveWorkspaces = new Map()) {
  const ago = folder.updatedAt ? timeAgo(folder.updatedAt)
    : folder.createdAt ? timeAgo(folder.createdAt) : '';

  const actionBtns = `
    <button class="saved-folder-btn" data-action="folder-up"     data-folder-id="${folder.id}" title="Move up">${CHEVRON_UP}</button>
    <button class="saved-folder-btn" data-action="folder-down"   data-folder-id="${folder.id}" title="Move down">${CHEVRON_DOWN}</button>
    <button class="saved-folder-btn" data-action="rename-folder" data-folder-id="${folder.id}" title="Rename">${PENCIL_SVG}</button>
    <button class="saved-folder-btn danger" data-action="delete-folder" data-folder-id="${folder.id}" title="Delete">${TRASH_SVG}</button>`;

  const body = items.map(item =>
    item.kind === 'group'
      ? renderDeferredGroup(item, storedIcons, liveWorkspaces)
      : renderDeferredItem(item)
  ).join('');

  return `
    <div class="saved-folder" data-saved-folder-id="${folder.id}">
      <div class="saved-folder-header" data-action="toggle-saved-folder" data-folder-id="${folder.id}">
        <svg class="saved-folder-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5"/></svg>
        <span class="saved-folder-name">${escHtml(folder.name)}</span>
        <div class="saved-folder-meta">
          <span>${items.length}</span>
          ${ago ? `<span>· ${ago}</span>` : ''}
        </div>
        <div class="saved-folder-actions">${actionBtns}</div>
      </div>
      <div class="saved-folder-body">${body}</div>
    </div>`;
}
