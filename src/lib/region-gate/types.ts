export type RegionGateVerdict = 'allowed' | 'blocked' | 'unknown';

export interface GeoResult {
  countryCode: string | null;
  ip: string | null;
  source: string;
  latencyMs: number;
}

export interface RegionGateResult {
  verdict: RegionGateVerdict;
  countryCode: string | null;
  ip: string | null;
  reason: string;
  sources: GeoResult[];
  checkedAt: number;
}

export interface RegionGateConfig {
  blockedCountries?: string[];
  providerTimeoutMs?: number;
  minSuccessfulProviders?: number;
  recheckIntervalMs?: number;
  fetchFn?: typeof fetch;
  onVerdictChange?: (result: RegionGateResult) => void;
  /** Подмножество провайдеров (быстрая проверка) */
  providers?: import('./providers').ProviderFn[];
}

export interface RegionGateController {
  check: () => Promise<RegionGateResult>;
  startPeriodicCheck: () => void;
  stopPeriodicCheck: () => void;
  getLastResult: () => RegionGateResult | null;
  dispose: () => void;
}
