/* ================================================================
   storage.js — chrome.storage.local CRUD

   All persistence for Tab Out lives here. Two keys:
     - 'deferred'       → array of saved tabs / saved tab groups
     - 'workspaceIcons' → { workspaceName: emoji|url } overrides

   Data shape stored under the "deferred" key:
   [
     // Individual saved tab (legacy entries lack the `kind` field)
     {
       id, url, title,
       workspaceId, workspaceName, index, windowId,
       savedAt, completed, dismissed, completedAt?
     },
     // Grouped saved entry (multiple tabs from one domain card)
     {
       id, kind: 'group',
       label, domain,
       savedAt, completed, dismissed, completedAt?,
       items: [
         { id, url, title,
           workspaceId, workspaceName, index, windowId,
           dismissed }
       ]
     }
   ]
   ================================================================ */

'use strict';

import { friendlyDomain } from './format.js';


/* ----------------------------------------------------------------
   SAVED FOR LATER — individual tabs
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
export async function saveTabForLater(tab) {
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
export async function getSavedTabs() {
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
export async function checkOffSavedTab(id) {
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
export async function dismissSavedTab(id) {
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
export async function restoreArchivedTab(id) {
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

   A "group" entry bundles multiple tabs saved together from a single
   domain card. Per-item dismissed flag; group is auto-dismissed when
   every item is dismissed.
   ---------------------------------------------------------------- */

/**
 * saveGroupForLater(group, { directToArchive })
 *
 * Persists a whole domain group (all tabs + per-tab restore metadata)
 * as a single grouped entry in chrome.storage.local.
 */
export async function saveGroupForLater(group, options = {}) {
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
export async function dismissGroupItem(groupId, itemId) {
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
export async function checkOffGroup(groupId) {
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
export async function dismissGroup(groupId) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const group = deferred.find(g => g.id === groupId && g.kind === 'group');
  if (!group) return;
  group.dismissed = true;
  await chrome.storage.local.set({ deferred });
}

/**
 * restoreArchivedGroup(groupId) — move an archived group back to active saved.
 */
export async function restoreArchivedGroup(groupId) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const group = deferred.find(g => g.id === groupId && g.kind === 'group');
  if (!group) return;
  group.completed = false;
  delete group.completedAt;
  await chrome.storage.local.set({ deferred });
}


/* ----------------------------------------------------------------
   WORKSPACE NAME MIGRATION

   Self-healing for Opera GX workspace renames. The 'workspaceIcons'
   key is keyed by workspace NAME (not id, since ids can shift), so when
   a workspace gets renamed we have to walk every saved group and move
   the user's emoji from the old name key to the new name key.
   ---------------------------------------------------------------- */

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
export function migrateWorkspaceNames(deferred, storedIcons, liveWorkspaces) {
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
   WORKSPACE ICONS

   User-picked workspace emojis live under the 'workspaceIcons' key,
   keyed by workspace NAME (not id, since ids can shift). The in-UI
   picker (pencil on each workspace pill) is the only way to manage them.
   ---------------------------------------------------------------- */

export async function getWorkspaceIconOverrides() {
  const { workspaceIcons = {} } = await chrome.storage.local.get('workspaceIcons');
  return workspaceIcons;
}

export async function setWorkspaceIconOverride(name, icon) {
  const overrides = await getWorkspaceIconOverrides();
  if (icon) overrides[name] = icon;
  else delete overrides[name];
  await chrome.storage.local.set({ workspaceIcons: overrides });
}
