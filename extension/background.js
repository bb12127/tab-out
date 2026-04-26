/**
 * background.js — Service Worker for Badge Updates + Toolbar Launcher
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Toolbar icon launcher ────────────────────────────────────────────────────
//
// Clicking the Tab Out icon opens the dashboard as a fresh tab right next to
// wherever the user currently is. Any pre-existing Tab Out tab (in this or
// any other window/workspace) is closed first — we never keep stale copies.
chrome.action.onClicked.addListener(async () => {
  const newtabUrl = chrome.runtime.getURL("index.html");

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // If the user is already ON a Tab Out tab, just reload it — no need to
    // close/recreate (would be destructive if it's the only tab in the window).
    if (activeTab && activeTab.url === newtabUrl) {
      await chrome.tabs.reload(activeTab.id);
      return;
    }

    // Close any stale Tab Out copies elsewhere so only one ever exists.
    const allTabs = await chrome.tabs.query({});
    const stale   = allTabs.filter(t => t.url === newtabUrl);
    if (stale.length > 0) {
      await chrome.tabs.remove(stale.map(t => t.id));
    }

    // Open a fresh Tab Out tab in the current window, right after the active
    // tab, in the active workspace (inherits workspace via index on Opera GX).
    const createOpts = { url: newtabUrl, active: true };
    if (activeTab) {
      createOpts.windowId = activeTab.windowId;
      if (typeof activeTab.index === 'number') createOpts.index = activeTab.index + 1;
      if (activeTab.workspaceId) createOpts.workspaceId = activeTab.workspaceId;
    }
    await chrome.tabs.create(createOpts);
  } catch (err) {
    // Fallback: just create one somewhere
    chrome.tabs.create({ url: newtabUrl });
  }
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
