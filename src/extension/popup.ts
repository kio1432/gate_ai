import type { RegionGateResult } from '../lib/region-gate';

const SETTINGS_KEY = 'gate:settings';
const DEFAULT_RECHECK_SEC = 1;

const INTERVAL_LABELS: Record<number, string> = {
  1: '1 секунда',
  5: '5 секунд',
  10: '10 секунд',
  30: '30 секунд',
  60: '1 минута',
  300: '5 минут',
};

function formatInterval(sec: number): string {
  return INTERVAL_LABELS[sec] ?? (sec < 60 ? `${sec} сек` : `${Math.round(sec / 60)} мин`);
}

async function readSettings(): Promise<number> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const stored = data[SETTINGS_KEY] as { recheckIntervalSec?: number } | undefined;
    return stored?.recheckIntervalSec ?? DEFAULT_RECHECK_SEC;
  } catch {
    return DEFAULT_RECHECK_SEC;
  }
}

async function writeSettings(recheckIntervalSec: number): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { recheckIntervalSec } });
}

function renderStatus(result: RegionGateResult | null, intervalSec: number) {
  const status = document.getElementById('status');
  const label = document.getElementById('label');
  const meta = document.getElementById('meta');
  if (!status || !label || !meta) return;

  const intervalLabel = formatInterval(intervalSec);

  if (!result) {
    status.className = 'status unknown';
    label.textContent = 'Проверка…';
    meta.textContent = `Шлюз перед входом + каждые ${intervalLabel} на вкладке\nClaude не видит IP до проверки VPN`;
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

  meta.textContent = `Проверка: при входе + каждые ${intervalLabel} на вкладке\nЗащищает: claude.ai, claude.com`;
}

async function sendMessage<T>(msg: object): Promise<T | null> {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    return null;
  }
}

async function load(): Promise<void> {
  const result = await sendMessage<RegionGateResult>({ type: 'GET_STATUS' });
  const intervalSec = await readSettings();
  const select = document.getElementById('interval') as HTMLSelectElement | null;
  if (select) {
    select.value = String(intervalSec);
  }
  renderStatus(result, intervalSec);
}

load().catch(() => load());

const intervalSelect = document.getElementById('interval');
if (intervalSelect) {
  intervalSelect.addEventListener('change', async (ev) => {
    const sec = Number((ev.target as HTMLSelectElement).value);
    await writeSettings(sec);
    const result = await sendMessage<RegionGateResult>({ type: 'GET_STATUS' });
    renderStatus(result, sec);
  });
}

const retryBtn = document.getElementById('retry');
if (retryBtn) {
  retryBtn.addEventListener('click', async (ev) => {
    const btn = ev.target as HTMLButtonElement;
    const select = document.getElementById('interval') as HTMLSelectElement | null;
    const sec = Number(select?.value ?? DEFAULT_RECHECK_SEC);
    btn.disabled = true;
    const result = await sendMessage<RegionGateResult>({ type: 'RECHECK', force: true });
    renderStatus(result, sec);
    btn.disabled = false;
  });
}
