export const SETTINGS_KEY = 'gate:settings';

export const DEFAULT_RECHECK_SEC = 1;

export interface GateSettings {
  recheckIntervalSec: number;
}

export const RECHECK_OPTIONS: { sec: number; label: string }[] = [
  { sec: 1, label: '1 секунда' },
  { sec: 5, label: '5 секунд' },
  { sec: 10, label: '10 секунд' },
  { sec: 30, label: '30 секунд' },
  { sec: 60, label: '1 минута' },
  { sec: 300, label: '5 минут' },
];

export async function getSettings(): Promise<GateSettings> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = data[SETTINGS_KEY] as GateSettings | undefined;
  return { recheckIntervalSec: stored?.recheckIntervalSec ?? DEFAULT_RECHECK_SEC };
}

export async function saveSettings(settings: GateSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function formatInterval(sec: number): string {
  const opt = RECHECK_OPTIONS.find((o) => o.sec === sec);
  if (opt) return opt.label;
  if (sec < 60) return `${sec} сек`;
  return `${Math.round(sec / 60)} мин`;
}
