import { normalizeDomain } from './domains';

export const SETTINGS_KEY = 'gate:settings';

export const DEFAULT_RECHECK_SEC = 1;

export interface GateSettings {
  recheckIntervalSec: number;
  customDomains: string[];
}

export const RECHECK_OPTIONS: { sec: number; label: string }[] = [
  { sec: 1, label: '1 секунда' },
  { sec: 5, label: '5 секунд' },
  { sec: 10, label: '10 секунд' },
  { sec: 30, label: '30 секунд' },
  { sec: 60, label: '1 минута' },
  { sec: 300, label: '5 минут' },
];

const DEFAULT_SETTINGS: GateSettings = {
  recheckIntervalSec: DEFAULT_RECHECK_SEC,
  customDomains: [],
};

export function normalizeSettings(raw: Partial<GateSettings> | undefined): GateSettings {
  const customDomains: string[] = [];
  const seen = new Set<string>();

  for (const item of raw?.customDomains ?? []) {
    const d = normalizeDomain(item);
    if (d && !seen.has(d)) {
      seen.add(d);
      customDomains.push(d);
    }
  }

  const sec = raw?.recheckIntervalSec ?? DEFAULT_RECHECK_SEC;
  const validSec = RECHECK_OPTIONS.some((o) => o.sec === sec) ? sec : DEFAULT_RECHECK_SEC;

  return { recheckIntervalSec: validSec, customDomains };
}

export async function getSettings(): Promise<GateSettings> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(data[SETTINGS_KEY] as Partial<GateSettings> | undefined);
}

export async function saveSettings(settings: GateSettings): Promise<GateSettings> {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export function formatInterval(sec: number): string {
  const opt = RECHECK_OPTIONS.find((o) => o.sec === sec);
  if (opt) return opt.label;
  if (sec < 60) return `${sec} сек`;
  return `${Math.round(sec / 60)} мин`;
}
