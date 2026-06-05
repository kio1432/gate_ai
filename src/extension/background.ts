import { createRegionGate, isAccessGranted } from '../lib/region-gate';
import type { RegionGateResult } from '../lib/region-gate';
import { FAST_PROVIDERS } from '../lib/region-gate/providers';
import { disableBlocking, enableBlocking } from './rules';
import {
  DEFAULT_RECHECK_SEC,
  getSettings,
  saveSettings,
  SETTINGS_KEY,
  type GateSettings,
} from './settings';
import { redirectBlockedTabsToClaude, redirectClaudeTabsToBlocked } from './tabs';

const STORAGE_KEY = 'gate:lastResult';
const SESSION_KEY = 'gate:sessionActive';

let fullCheckPromise: Promise<RegionGateResult> | null = null;

async function getLastResult(): Promise<RegionGateResult | null> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] as RegionGateResult) ?? null;
}

async function setSessionActive(active: boolean): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: active });
}

async function applyVerdict(
  result: RegionGateResult,
  prev: RegionGateResult | null
): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: result });

  if (isAccessGranted(result)) {
    await setSessionActive(true);
    await disableBlocking();
    if (!prev || !isAccessGranted(prev)) {
      await redirectBlockedTabsToClaude();
    }
  } else {
    await setSessionActive(false);
    await enableBlocking();
    await redirectClaudeTabsToBlocked();
  }
}

async function doCheck(fast: boolean): Promise<RegionGateResult> {
  const prev = await getLastResult();
  const gate = createRegionGate({
    providerTimeoutMs: fast ? 2000 : 5000,
    minSuccessfulProviders: 1,
    providers: fast ? FAST_PROVIDERS : undefined,
  });
  const result = await gate.check();
  await applyVerdict(result, prev);
  gate.dispose();
  return result;
}

function runCheck(opts: { force?: boolean; fast?: boolean } = {}): Promise<RegionGateResult> {
  const fast = opts.fast !== false;

  if (fast) {
    return doCheck(true);
  }

  if (fullCheckPromise && !opts.force) return fullCheckPromise;

  if (fullCheckPromise && opts.force) {
    fullCheckPromise = fullCheckPromise.then(() => doCheck(false));
    return fullCheckPromise;
  }

  fullCheckPromise = doCheck(false).finally(() => {
    fullCheckPromise = null;
  });
  return fullCheckPromise;
}

async function ensureSettings(): Promise<void> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  if (!data[SETTINGS_KEY]) {
    await saveSettings({ recheckIntervalSec: DEFAULT_RECHECK_SEC });
  }
}

async function init(): Promise<void> {
  await ensureSettings();
  // Всегда блокируем до свежей проверки — Claude не видит IP до прохождения шлюза
  await setSessionActive(false);
  await enableBlocking();
}

chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => void init());
void init();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'WAKE') {
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'RECHECK') {
    void runCheck({ force: !!msg.force, fast: msg.fast !== false }).then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_STATUS') {
    void getLastResult().then(sendResponse);
    return true;
  }
  if (msg.type === 'GET_SETTINGS') {
    void getSettings().then(sendResponse);
    return true;
  }
  if (msg.type === 'SAVE_SETTINGS') {
    void saveSettings(msg.settings as GateSettings).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
