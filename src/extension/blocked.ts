const STORAGE_KEY = 'gate:lastResult';
const SETTINGS_KEY = 'gate:settings';
const DEFAULT_RECHECK_SEC = 1;
// Куда уходим после успешной проверки, если фон не знает исходный URL
// (например, blocked.html открыли напрямую или SW потерял карту).
const FALLBACK_TARGET = 'https://claude.ai';

// Исходный ресурс, на который пользователь шёл до блокировки. Заполняется
// один раз при загрузке из фона, чтобы render() сразу знал, куда вернуть.
let returnUrl: string | null = null;

// Предохранитель от петли: если blocked.html грузится слишком часто (нас
// заворачивает обратно), перестаём авто-уходить на Claude и ждём ручного
// "Проверить снова". Fail-closed: в петле остаёмся на безопасной странице.
const BOUNCE_WINDOW_MS = 8000;
const BOUNCE_MAX = 4;
const LOADS_KEY = 'bai_blocked_loads';

function tripped(): boolean {
  const now = Date.now();
  let arr: number[] = [];
  try {
    arr = JSON.parse(sessionStorage.getItem(LOADS_KEY) || '[]');
  } catch {
    arr = [];
  }
  arr = arr.filter((t) => now - t < BOUNCE_WINDOW_MS);
  arr.push(now);
  sessionStorage.setItem(LOADS_KEY, JSON.stringify(arr));
  return arr.length > BOUNCE_MAX;
}

let circuitTripped = tripped();
if (circuitTripped) {
  console.warn('[BlockAI] blocked.html: обнаружена петля редиректов — авто-переход остановлен');
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

type Verdict = 'allowed' | 'blocked' | 'unknown';
interface GateResult {
  verdict: Verdict;
  countryCode: string | null;
}

function isGranted(result: GateResult | null): boolean {
  return result?.verdict === 'allowed';
}

function render(result: GateResult | null) {
  console.log('[BlockAI] blocked.render', result, 'tripped=', circuitTripped);
  if (result && isGranted(result) && !circuitTripped) {
    const target = returnUrl ?? FALLBACK_TARGET;
    console.log('[BlockAI] blocked -> back to', target);
    window.location.replace(target);
    return;
  }

  const isBlocked = result?.verdict === 'blocked';
  const icon = document.getElementById('icon')!;
  const title = document.getElementById('title')!;
  const message = document.getElementById('message')!;
  const region = document.getElementById('region')!;
  const reason = document.getElementById('reason')!;

  icon.textContent = '🔒';
  if (circuitTripped && result && isGranted(result)) {
    title.textContent = 'Доступ разрешён';
    message.textContent =
      'VPN подтверждён. Нажмите «Проверить снова», чтобы продолжить.';
  } else {
    title.textContent = isBlocked ? 'Включите VPN' : 'Проверьте VPN';
    message.textContent = isBlocked
      ? 'Похоже, вы забыли включить VPN. Перед началом работы убедитесь, что VPN включён и подключён к разрешённому региону.'
      : 'Не удалось подтвердить регион. Включите VPN, проверьте подключение и повторите попытку.';
  }

  region.hidden = true;
  reason.hidden = true;
}

async function sendRecheck(force: boolean): Promise<GateResult | null> {
  try {
    return await chrome.runtime.sendMessage({ type: 'RECHECK', force, fast: true });
  } catch {
    await chrome.runtime.sendMessage({ type: 'WAKE' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    return chrome.runtime.sendMessage({ type: 'RECHECK', force, fast: true });
  }
}

async function getPollMs(): Promise<number> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = data[SETTINGS_KEY] as { recheckIntervalSec?: number } | undefined;
    return (stored?.recheckIntervalSec ?? DEFAULT_RECHECK_SEC) * 1000;
  } catch {
    return DEFAULT_RECHECK_SEC * 1000;
  }
}

// Авто-перепроверка: после включения/смены VPN страница сама уйдёт на Claude
async function startPolling(): Promise<void> {
  if (pollTimer) clearInterval(pollTimer);
  const ms = await getPollMs();
  pollTimer = setInterval(() => {
    // Опрос без force — использует кэш фона, провайдеры не флудятся
    void sendRecheck(false).then((result) => render(result ?? null));
  }, ms);
}

async function fetchReturnUrl(): Promise<string | null> {
  try {
    const resp = (await chrome.runtime.sendMessage({ type: 'GET_RETURN_URL' })) as
      | { url?: string | null }
      | undefined;
    const url = resp?.url ?? null;
    // Принимаем только http(s), чтобы не уйти на chrome-extension://blocked.html
    return url && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

// Сначала узнаём исходный URL, и только затем запускаем проверку: иначе вердикт
// "allowed" может прийти раньше и render() уведёт на запасной claude.ai.
async function init(): Promise<void> {
  returnUrl = await fetchReturnUrl();
  void sendRecheck(true).then((result) => render(result ?? null));
  void startPolling();
}
void init();

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) {
    render(changes[STORAGE_KEY].newValue ?? null);
  }
  if (changes[SETTINGS_KEY]) {
    void startPolling();
  }
});

document.getElementById('retry')!.addEventListener('click', async (e) => {
  const btn = e.target as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Проверяем…';
  // Ручная проверка снимает предохранитель и обнуляет счётчик петли
  circuitTripped = false;
  sessionStorage.removeItem(LOADS_KEY);
  try {
    const result = await sendRecheck(true);
    render(result ?? null);
  } catch {
    btn.textContent = 'Ошибка — попробуйте снова';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Проверить снова';
    }, 2000);
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Проверить снова';
});

// Изолируем область видимости от других entry-скриптов (см. content.ts).
export {};
