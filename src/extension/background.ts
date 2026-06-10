import { createRegionGate, isAccessGranted } from '../lib/region-gate';
import type { RegionGateResult } from '../lib/region-gate';
import { FAST_PROVIDERS } from '../lib/region-gate/providers';
import { isGatedUrl } from './domains';
import { disableBlocking, dumpDnrState, enableBlocking } from './rules';
import {
  DEFAULT_RECHECK_SEC,
  getSettings,
  saveSettings,
  SETTINGS_KEY,
  type GateSettings,
} from './settings';

const STORAGE_KEY = 'gate:lastResult';
const SESSION_KEY = 'gate:sessionActive';
// Карта tabId -> исходный URL, на который пользователь шёл, прежде чем его
// завернуло на blocked.html. Нужна, чтобы после успешной проверки вернуть
// человека ИМЕННО на запрошенный ресурс (claude.com, своя зона и т.п.),
// а не на жёстко зашитый claude.ai. Храним в session-storage: переживает
// выгрузку service worker'а, но очищается при перезапуске браузера.
const RETURN_URLS_KEY = 'gate:returnUrls';
// Состояние шлюза в session-storage: переживает выгрузку service worker'а,
// но очищается при перезапуске браузера → на старте всегда fail-closed.
const GATE_OPEN_KEY = 'gate:open';

// Сколько подряд "unknown" терпим ПОСЛЕ успешного входа, прежде чем закрыть.
// Защищает от мигания при кратковременных сбоях GeoIP-провайдеров.
// "blocked" (реальный RU) закрывает доступ мгновенно, в обход грейса.
const UNKNOWN_GRACE = 3;

// TTL кэша вердикта. Все опросы (несколько вкладок × интервал) в этом окне
// переиспользуют один результат — провайдеры GeoIP не флудятся и не дают
// rate-limit → unknown → мигание. force:true (кнопка "Проверить") обходит кэш.
const CHECK_TTL_MS = 4000;

// Кулдаун на ПОВТОРНОЕ открытие шлюза после закрытия. Жёстко ломает петлю
// redirect↔redirect: даже если проверка тут же говорит "allowed", шлюз не
// откроется раньше кулдауна, а в storage держим не-allowed, чтобы страницы
// не прыгали туда-сюда. Открыть преждевременно нельзя → fail-closed сохранён.
const REOPEN_COOLDOWN_MS = 5000;

let inFlightCheck: Promise<RegionGateResult> | null = null;
let cachedResult: RegionGateResult | null = null;
let cachedAt = 0;
let blockingActive = true;
// Текущее применённое состояние шлюза, чтобы не дёргать правила/редиректы зря
let gateOpen = false;
let unknownStreak = 0;
let reopenAllowedAt = 0;
// Кэш пользовательских доменов для дешёвой проверки в onBeforeNavigate
// (событие срабатывает на КАЖДУЮ навигацию — getSettings там был бы расточителен).
let cachedCustomDomains: string[] = [];

async function getLastResult(): Promise<RegionGateResult | null> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] as RegionGateResult) ?? null;
}

// Сериализация изменений карты returnUrls: read-modify-write на session-storage
// из параллельных навигаций (несколько вкладок) иначе мог бы терять записи.
let returnUrlsQueue: Promise<void> = Promise.resolve();

function mutateReturnUrls(
  mutate: (map: Record<string, string>) => boolean
): Promise<void> {
  const task = async (): Promise<void> => {
    try {
      const data = await chrome.storage.session.get(RETURN_URLS_KEY);
      const map = (data[RETURN_URLS_KEY] as Record<string, string>) ?? {};
      if (!mutate(map)) return;
      await chrome.storage.session.set({ [RETURN_URLS_KEY]: map });
    } catch {
      // session-storage недоступен — просто не сможем вернуть на исходный URL
    }
  };
  returnUrlsQueue = returnUrlsQueue.then(task, task);
  return returnUrlsQueue;
}

function rememberReturnUrl(tabId: number, url: string): Promise<void> {
  if (tabId < 0) return Promise.resolve();
  return mutateReturnUrls((map) => {
    map[tabId] = url;
    return true;
  });
}

async function getReturnUrl(tabId: number | undefined): Promise<string | null> {
  if (tabId == null || tabId < 0) return null;
  // Дожидаемся хвоста очереди записей, чтобы прочитать согласованное состояние.
  await returnUrlsQueue.catch(() => {});
  try {
    const data = await chrome.storage.session.get(RETURN_URLS_KEY);
    const map = (data[RETURN_URLS_KEY] as Record<string, string>) ?? {};
    return map[tabId] ?? null;
  } catch {
    return null;
  }
}

function forgetReturnUrl(tabId: number): Promise<void> {
  return mutateReturnUrls((map) => {
    if (!(tabId in map)) return false;
    delete map[tabId];
    return true;
  });
}

async function setSessionActive(active: boolean): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: active });
}

async function persistGateOpen(open: boolean): Promise<void> {
  try {
    await chrome.storage.session.set({ [GATE_OPEN_KEY]: open });
  } catch {
    // session-storage недоступен — не критично, просто не переживём выгрузку SW
  }
}

async function readGateOpen(): Promise<boolean> {
  try {
    const data = await chrome.storage.session.get(GATE_OPEN_KEY);
    return data[GATE_OPEN_KEY] === true;
  } catch {
    return false;
  }
}

/** Гистерезис: сглаживаем transient unknown, RU — мгновенно */
function effectiveVerdict(raw: RegionGateResult): RegionGateResult {
  if (raw.verdict === 'allowed') {
    unknownStreak = 0;
    return raw;
  }
  if (raw.verdict === 'blocked') {
    unknownStreak = 0;
    return raw;
  }
  // unknown
  if (gateOpen) {
    unknownStreak += 1;
    if (unknownStreak < UNKNOWN_GRACE) {
      // Держим прошлый успешный вердикт — без мигания
      return { ...raw, verdict: 'allowed', reason: 'grace: transient unknown' };
    }
  }
  return raw;
}

async function applyVerdict(raw: RegionGateResult): Promise<RegionGateResult> {
  const settings = await getSettings();
  const base = effectiveVerdict(raw);
  const now = Date.now();

  let wantOpen = isAccessGranted(base);

  console.log(
    '[BlockAI] bg.applyVerdict raw=%s base=%s wantOpen=%s gateOpen=%s cooldownLeft=%dms',
    raw.verdict,
    base.verdict,
    wantOpen,
    gateOpen,
    Math.max(0, reopenAllowedAt - now)
  );

  // Кулдаун повторного открытия: после закрытия нельзя открыть раньше времени.
  // Это ломает петлю, не ослабляя fail-closed (можем только задержать доступ).
  if (wantOpen && !gateOpen && now < reopenAllowedAt) {
    wantOpen = false;
  }

  // Вердикт, СОГЛАСОВАННЫЙ с реальным решением шлюза. Иначе blocked.html увидит
  // allowed и попытается уйти на Claude, который DNR тут же вернёт обратно → петля.
  const stored: RegionGateResult =
    wantOpen || base.verdict !== 'allowed'
      ? base
      : { ...base, verdict: 'unknown', reason: 'reopen cooldown' };

  // КРИТИЧНО: сначала переключаем DNR, и ТОЛЬКО ПОТОМ пишем вердикт в storage.
  // Страницы (blocked.ts/content.ts) реагируют на запись в storage. Если бы мы
  // записали allowed ДО выключения DNR, blocked.html ушёл бы на Claude при ещё
  // включённом DNR → мгновенный редирект назад → петля (особенно на N вкладках).
  if (wantOpen !== gateOpen) {
    console.log('[BlockAI] bg.gate %s -> %s (DNR %s)', gateOpen, wantOpen, wantOpen ? 'OFF' : 'ON');
    gateOpen = wantOpen;
    if (wantOpen) {
      blockingActive = false;
      await disableBlocking();
      await setSessionActive(true);
    } else {
      blockingActive = true;
      reopenAllowedAt = now + REOPEN_COOLDOWN_MS;
      await enableBlocking(settings.customDomains);
      await setSessionActive(false);
    }
    await persistGateOpen(wantOpen);
    await dumpDnrState(wantOpen ? 'afterOpen' : 'afterClose');
  }

  // Запись вердикта — ПОСЛЕ применения сетевых правил: когда страница увидит
  // allowed, DNR уже выключен и переход на Claude не будет завёрнут обратно.
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });

  return stored;
}

async function doCheck(fast: boolean): Promise<RegionGateResult> {
  const gate = createRegionGate({
    providerTimeoutMs: fast ? 2000 : 5000,
    minSuccessfulProviders: 1,
    providers: fast ? FAST_PROVIDERS : undefined,
  });
  const raw = await gate.check();
  const effective = await applyVerdict(raw);
  gate.dispose();
  cachedResult = effective;
  cachedAt = Date.now();
  return effective;
}

// Single-flight + TTL-кэш. Параллельные RECHECK переиспользуют идущую проверку;
// последовательные опросы в пределах CHECK_TTL_MS получают закэшированный
// результат, не нагружая провайдеров. force:true всегда запускает свежую.
function runCheck(opts: { force?: boolean; fast?: boolean } = {}): Promise<RegionGateResult> {
  if (inFlightCheck) return inFlightCheck;

  if (!opts.force && cachedResult && Date.now() - cachedAt < CHECK_TTL_MS) {
    return Promise.resolve(cachedResult);
  }

  const fast = opts.fast !== false;
  inFlightCheck = doCheck(fast).finally(() => {
    inFlightCheck = null;
  });
  return inFlightCheck;
}

async function ensureSettings(): Promise<void> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  if (!data[SETTINGS_KEY]) {
    await saveSettings({
      recheckIntervalSec: DEFAULT_RECHECK_SEC,
      customDomains: [],
    });
  }
}

// Полный fail-closed сброс: установка/запуск браузера. Доступ закрыт, пока VPN
// не подтверждён. Чистим session-флаг шлюза.
async function bootClosed(): Promise<void> {
  console.log('[BlockAI] bg.bootClosed (fail-closed reset)');
  await ensureSettings();
  const settings = await getSettings();
  cachedCustomDomains = settings.customDomains;
  gateOpen = false;
  unknownStreak = 0;
  cachedResult = null;
  cachedAt = 0;
  reopenAllowedAt = 0;
  await persistGateOpen(false);
  await setSessionActive(false);
  blockingActive = true;
  await enableBlocking(settings.customDomains);
}

// Пробуждение выгруженного service worker'а ПОСРЕДИ сессии. Восстанавливаем
// ранее применённое состояние из session-storage, НЕ переоткрывая/перезакрывая
// зря. session-storage пуст после рестарта браузера → там будет fail-closed.
async function restoreOnWake(): Promise<void> {
  await ensureSettings();
  const settings = await getSettings();
  cachedCustomDomains = settings.customDomains;
  const open = await readGateOpen();
  console.log('[BlockAI] bg.restoreOnWake gateOpen=%s (DNR %s)', open, open ? 'OFF' : 'ON');
  await dumpDnrState('restoreOnWake:before');
  gateOpen = open;
  if (open) {
    blockingActive = false;
    await disableBlocking();
  } else {
    blockingActive = true;
    await enableBlocking(settings.customDomains);
  }
  await dumpDnrState('restoreOnWake:after');
}

chrome.runtime.onInstalled.addListener(() => void bootClosed());
chrome.runtime.onStartup.addListener(() => void bootClosed());
// Верхний уровень выполняется при КАЖДОМ пробуждении SW — здесь только
// восстановление, а не принудительное закрытие (иначе мигание при выгрузке SW).
void restoreOnWake();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  void (async () => {
    const settings = await getSettings();
    cachedCustomDomains = settings.customDomains;
    if (blockingActive) {
      await enableBlocking(settings.customDomains);
    }
  })();
});

// Запоминаем, куда пользователь шёл, ДО того как DNR (или content.ts) завернёт
// навигацию на blocked.html. Сохраняем только для главного фрейма и только для
// "защищаемых" хостов, чтобы не писать в storage на каждую навигацию подряд.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!/^https?:\/\//i.test(details.url)) return;
  let host: string;
  let pathname: string;
  try {
    const u = new URL(details.url);
    host = u.hostname;
    pathname = u.pathname;
  } catch {
    return;
  }
  if (!isGatedUrl(host, pathname, cachedCustomDomains)) return;
  void rememberReturnUrl(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetReturnUrl(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
  if (msg.type === 'GET_RETURN_URL') {
    void getReturnUrl(sender.tab?.id).then((url) => sendResponse({ url }));
    return true;
  }
  if (msg.type === 'GET_SETTINGS') {
    void getSettings().then(sendResponse);
    return true;
  }
  if (msg.type === 'SAVE_SETTINGS') {
    void saveSettings(msg.settings as GateSettings).then((saved) => {
      sendResponse(saved);
    });
    return true;
  }
});
