// Автономный popup: без импортов, чтобы собранный popup.js не содержал import-ов
// и гарантированно работал даже без type="module".

interface PopupResult {
  verdict: 'allowed' | 'blocked' | 'unknown';
  countryCode: string | null;
}

const STORAGE_KEY = 'gate:lastResult';
const SETTINGS_KEY = 'gate:settings';
const DEFAULT_RECHECK_SEC = 1;
const DEFAULT_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com'];
const VALID_SECS = [1, 5, 10, 30, 60, 300];

const INTERVAL_LABELS: Record<number, string> = {
  1: '1 секунда',
  5: '5 секунд',
  10: '10 секунд',
  30: '30 секунд',
  60: '1 минута',
  300: '5 минут',
};

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

let customDomains: string[] = [];

function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;

  let pathname = '';

  if (/^https?:\/\//.test(s)) {
    try {
      const url = new URL(s);
      s = url.hostname;
      if (url.pathname && url.pathname !== '/') {
        pathname = url.pathname.replace(/\/+$/, '');
      }
    } catch {
      return null;
    }
  } else {
    const slashIdx = s.indexOf('/');
    if (slashIdx !== -1) {
      pathname = s.slice(slashIdx).replace(/\/+$/, '');
      s = s.slice(0, slashIdx);
    }
  }

  s = s.replace(/^\*\./, '').replace(/^\.+/, '');
  if (!s || s.includes('*') || s.includes('/') || !DOMAIN_RE.test(s)) return null;

  if (pathname && pathname !== '/') {
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
    if (/[?#\s]/.test(pathname)) return null;
    return `${s}${pathname}`;
  }

  return s;
}

function dedupeDomains(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const d = normalizeDomain(item);
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

function formatInterval(sec: number): string {
  return INTERVAL_LABELS[sec] ?? (sec < 60 ? `${sec} сек` : `${Math.round(sec / 60)} мин`);
}

function formatDomainsPreview(): string {
  const custom = customDomains.length ? ` + ${customDomains.join(', ')}` : '';
  return `${DEFAULT_DOMAINS.join(', ')}${custom}`;
}

async function readSettings(): Promise<{ recheckIntervalSec: number; customDomains: string[] }> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = data[SETTINGS_KEY] as
    | { recheckIntervalSec?: number; customDomains?: string[] }
    | undefined;
  const sec = raw?.recheckIntervalSec ?? DEFAULT_RECHECK_SEC;
  return {
    recheckIntervalSec: VALID_SECS.includes(sec) ? sec : DEFAULT_RECHECK_SEC,
    customDomains: dedupeDomains(raw?.customDomains ?? []),
  };
}

async function writeSettings(recheckIntervalSec: number): Promise<void> {
  const normalized = {
    recheckIntervalSec: VALID_SECS.includes(recheckIntervalSec)
      ? recheckIntervalSec
      : DEFAULT_RECHECK_SEC,
    customDomains: dedupeDomains(customDomains),
  };
  customDomains = normalized.customDomains;
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
}

async function getStatus(): Promise<PopupResult | null> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] as PopupResult) ?? null;
}

function renderDomainList(): void {
  const list = document.getElementById('domain-list');
  const empty = document.getElementById('domain-empty');
  if (!list || !empty) return;

  list.innerHTML = '';
  empty.hidden = customDomains.length > 0;

  for (const domain of customDomains) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    const slashIdx = domain.indexOf('/');
    label.textContent = slashIdx === -1
      ? `*.${domain}`
      : `*.${domain.slice(0, slashIdx)}${domain.slice(slashIdx)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.addEventListener('click', () => void removeDomain(domain));
    li.append(label, remove);
    list.appendChild(li);
  }
}

function showDomainError(msg: string): void {
  const el = document.getElementById('domain-error');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function currentInterval(): number {
  const select = document.getElementById('interval') as HTMLSelectElement | null;
  return Number(select?.value ?? DEFAULT_RECHECK_SEC);
}

async function removeDomain(domain: string): Promise<void> {
  customDomains = customDomains.filter((d) => d !== domain);
  renderDomainList();
  await writeSettings(currentInterval());
  renderStatus(await getStatus(), currentInterval());
}

async function addDomain(): Promise<void> {
  const input = document.getElementById('domain-input') as HTMLInputElement | null;
  const addBtn = document.getElementById('domain-add') as HTMLButtonElement | null;
  if (!input) return;

  const normalized = normalizeDomain(input.value);
  if (!normalized) {
    showDomainError('Некорректный домен или путь');
    return;
  }
  const hostPart = normalized.includes('/') ? normalized.split('/')[0] : normalized;
  if (DEFAULT_DOMAINS.some((d) => hostPart === d || hostPart.endsWith(`.${d}`))) {
    showDomainError('Домен уже защищён по умолчанию');
    return;
  }
  if (customDomains.includes(normalized)) {
    showDomainError('Домен уже добавлен');
    return;
  }

  if (addBtn) addBtn.disabled = true;
  showDomainError('');
  customDomains = [...customDomains, normalized];
  input.value = '';
  renderDomainList();

  try {
    await writeSettings(currentInterval());
    renderStatus(await getStatus(), currentInterval());
  } catch {
    customDomains = customDomains.filter((d) => d !== normalized);
    renderDomainList();
    showDomainError('Не удалось сохранить');
  } finally {
    if (addBtn) addBtn.disabled = false;
  }
}

function renderStatus(result: PopupResult | null, intervalSec: number) {
  const status = document.getElementById('status');
  const label = document.getElementById('label');
  const meta = document.getElementById('meta');
  if (!status || !label || !meta) return;

  const intervalLabel = formatInterval(intervalSec);
  const domainsLabel = formatDomainsPreview();

  if (!result) {
    status.className = 'status unknown';
    label.textContent = 'Проверка…';
    meta.textContent = `Шлюз перед входом + каждые ${intervalLabel}\n${domainsLabel}`;
    return;
  }

  if (result.verdict === 'allowed') {
    status.className = 'status ok';
    label.textContent = `VPN OK (${result.countryCode})`;
  } else if (result.verdict === 'blocked') {
    status.className = 'status blocked';
    label.textContent = 'Включите VPN';
  } else {
    status.className = 'status unknown';
    label.textContent = 'Проверьте VPN';
  }

  meta.textContent = `Проверка: при входе + каждые ${intervalLabel}\n${domainsLabel}`;
}

async function load(): Promise<void> {
  const verEl = document.getElementById('version');
  if (verEl) verEl.textContent = `v${chrome.runtime.getManifest().version}`;

  const settings = await readSettings();
  customDomains = settings.customDomains;

  const select = document.getElementById('interval') as HTMLSelectElement | null;
  if (select) select.value = String(settings.recheckIntervalSec);

  renderDomainList();
  renderStatus(await getStatus(), settings.recheckIntervalSec);
}

void load();

const intervalSelect = document.getElementById('interval');
if (intervalSelect) {
  intervalSelect.addEventListener('change', async (ev) => {
    const sec = Number((ev.target as HTMLSelectElement).value);
    await writeSettings(sec);
    renderStatus(await getStatus(), sec);
  });
}

const domainAdd = document.getElementById('domain-add');
if (domainAdd) domainAdd.addEventListener('click', () => void addDomain());

const domainInput = document.getElementById('domain-input');
if (domainInput) {
  domainInput.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') void addDomain();
  });
}

const retryBtn = document.getElementById('retry');
if (retryBtn) {
  retryBtn.addEventListener('click', async (ev) => {
    const btn = ev.target as HTMLButtonElement;
    const sec = currentInterval();
    btn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'RECHECK', force: true });
    } catch {
      await chrome.runtime.sendMessage({ type: 'WAKE' }).catch(() => {});
    }
    renderStatus(await getStatus(), sec);
    btn.disabled = false;
  });
}

// Изолируем область видимости от других entry-скриптов (см. content.ts).
export {};
