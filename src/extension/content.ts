const STORAGE_KEY = 'gate:lastResult';
const SETTINGS_KEY = 'gate:settings';
const DEFAULT_RECHECK_SEC = 1;
const BLOCKED_URL = chrome.runtime.getURL('blocked.html');
const HIDE_STYLE_ID = 'blockai-guard-hide';

const DEFAULT_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com'];

let recheckTimer: ReturnType<typeof setInterval> | null = null;
let active = false;

function patternHost(pattern: string): string {
  const s = pattern.trim().toLowerCase().replace(/^\*\./, '');
  const slash = s.indexOf('/');
  return slash === -1 ? s : s.slice(0, slash);
}

function patternPath(pattern: string): string | null {
  const s = pattern.trim().toLowerCase();
  const slash = s.indexOf('/');
  return slash === -1 ? null : s.slice(slash);
}

/**
 * Возвращает true, если hostname+pathname попадают под один из паттернов.
 * Паттерн "domain"      → любой путь на домене/поддоменах.
 * Паттерн "domain/path" → только если pathname = path или начинается с path/
 */
function isGatedUrl(hostname: string, pathname: string, customDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const pattern of [...DEFAULT_DOMAINS, ...customDomains]) {
    const d = patternHost(pattern);
    const p = patternPath(pattern);
    if (host !== d && !host.endsWith(`.${d}`)) continue;
    if (p === null) return true;
    if (pathname === p || pathname.startsWith(`${p}/`)) return true;
  }
  return false;
}

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

// Уводить на блок-страницу только при ПОДТВЕРЖДЁННОМ blocked (реальный RU).
// При allowed — показываем. При unknown/нет данных — НЕ редиректим (иначе
// claude.ai отскакивает на blocked.html, пока DNR/вердикт устаканиваются →
// петля). Раз страница уже загрузилась, шлюз был открыт; ждём вердикт скрыто.
function shouldRedirectToBlocked(result: { verdict: string } | null): boolean {
  return result?.verdict === 'blocked';
}

function redirectToBlocked(): void {
  hidePage();
  if (!window.location.href.startsWith(BLOCKED_URL)) {
    window.location.replace(BLOCKED_URL);
  }
}

function applyVerdict(result: { verdict: string } | null): void {
  if (!isDenied(result)) {
    console.log('[BlockAI] content: allowed -> reveal', window.location.host);
    revealPage();
    return;
  }
  if (shouldRedirectToBlocked(result)) {
    console.log('[BlockAI] content: blocked -> redirect', window.location.host, result);
    redirectToBlocked();
    return;
  }
  // unknown / нет данных — держим скрытым, ждём следующий вердикт, НЕ прыгаем
  console.log('[BlockAI] content: unknown -> hold hidden', window.location.host, result);
  hidePage();
}

function triggerRecheck(): void {
  chrome.runtime.sendMessage({ type: 'RECHECK', fast: true }).catch(() => {});
}

async function getRecheckMs(): Promise<number> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = data[SETTINGS_KEY] as { recheckIntervalSec?: number } | undefined;
  const sec = stored?.recheckIntervalSec ?? DEFAULT_RECHECK_SEC;
  return sec * 1000;
}

async function startRecheckLoop(): Promise<void> {
  if (recheckTimer) clearInterval(recheckTimer);
  const ms = await getRecheckMs();
  recheckTimer = setInterval(triggerRecheck, ms);
}

function boot(customDomains: string[]): void {
  if (!isGatedUrl(window.location.hostname, window.location.pathname, customDomains)) return;
  active = true;

  hidePage();

  chrome.storage.local.get(STORAGE_KEY, (data) => {
    applyVerdict(data[STORAGE_KEY] ?? null);
  });

  void startRecheckLoop();
  triggerRecheck();
}

chrome.storage.local.get(SETTINGS_KEY, (data) => {
  const settings = data[SETTINGS_KEY] as { customDomains?: string[] } | undefined;
  boot(settings?.customDomains ?? []);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[SETTINGS_KEY] && !active) {
    const next = changes[SETTINGS_KEY].newValue as { customDomains?: string[] } | undefined;
    boot(next?.customDomains ?? []);
  }
  if (!active) return;
  if (changes[STORAGE_KEY]) {
    applyVerdict(changes[STORAGE_KEY].newValue ?? null);
  }
  if (changes[SETTINGS_KEY]) {
    void startRecheckLoop();
  }
});

document.addEventListener('visibilitychange', () => {
  if (active && !document.hidden) triggerRecheck();
});

// Изолируем область видимости от других entry-скриптов (blocked/popup делят
// глобальную область в tsc). Пустой export не попадает в бандл classic-скрипта.
export {};
