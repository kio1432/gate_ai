import { ALLOWED_ENTRY_URL, CLAUDE_URL_PATTERNS } from './config';

export async function redirectClaudeTabsToBlocked(): Promise<void> {
  const blockedUrl = chrome.runtime.getURL('blocked.html');

  for (const pattern of CLAUDE_URL_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith(blockedUrl)) {
        await chrome.tabs.update(tab.id, { url: blockedUrl });
      }
    }
  }
}

export async function redirectBlockedTabsToClaude(): Promise<void> {
  const blockedUrl = chrome.runtime.getURL('blocked.html');
  const tabs = await chrome.tabs.query({ url: `${blockedUrl}*` });
  for (const tab of tabs) {
    if (tab.id) await chrome.tabs.update(tab.id, { url: ALLOWED_ENTRY_URL });
  }
}
