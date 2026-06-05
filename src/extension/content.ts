const STORAGE_KEY = 'gate:lastResult';
const SETTINGS_KEY = 'gate:settings';
const DEFAULT_RECHECK_SEC = 1;
const BLOCKED_URL = chrome.runtime.getURL('blocked.html');
const HIDE_STYLE_ID = 'blockai-guard-hide';

let recheckTimer: ReturnType<typeof setInterval> | null = null;

/** Скрыть страницу до подтверждения VPN — без вспышки контента */
function hidePage(): void {
  if (document.getElementById(HIDE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIDE_STYLE_ID;
  style.textContent =
    'html{visibility:hidden!important;background:#1a1a2e!important}';
  (document.documentElement || document.head).appendChild(style);
}

function revealPage(): void {
  document.getElementById(HIDE_STYLE_ID)?.remove();
}

function isDenied(result: { verdict: string } | null): boolean {
  return !result || result.verdict !== 'allowed';
}

function redirectToBlocked(): void {
  hidePage();
  if (!window.location.href.startsWith(BLOCKED_URL)) {
    window.location.replace(BLOCKED_URL);
  }
}

function applyVerdict(result: { verdict: string } | null): void {
  if (isDenied(result)) {
    redirectToBlocked();
  } else {
    revealPage();
  }
}

function triggerRecheck(): void {
  chrome.runtime.sendMessage({ type: 'RECHECK', fast: true }).catch(() => {});
}

async function getRecheckMs(): Promise<number> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const sec =
    (data[SETTINGS_KEY] as { recheckIntervalSec?: number } | undefined)
      ?.recheckIntervalSec ?? DEFAULT_RECHECK_SEC;
  return sec * 1000;
}

async function startRecheckLoop(): Promise<void> {
  if (recheckTimer) clearInterval(recheckTimer);
  const ms = await getRecheckMs();
  recheckTimer = setInterval(triggerRecheck, ms);
}

// Сразу скрыть — пока не подтвердим доступ
hidePage();

chrome.storage.local.get(STORAGE_KEY, (data) => {
  applyVerdict(data[STORAGE_KEY] ?? null);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) {
    applyVerdict(changes[STORAGE_KEY].newValue ?? null);
  }
  if (changes[SETTINGS_KEY]) {
    void startRecheckLoop();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) triggerRecheck();
});

void startRecheckLoop();
triggerRecheck();
