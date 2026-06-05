import { _resolveEndpoint } from './obfuscate';
import type { GeoResult } from './types';

export type ProviderFn = (fetchFn: typeof fetch, timeoutMs: number) => Promise<GeoResult>;

const fetchWithTimeout = (fetchFn: typeof fetch, url: string, timeoutMs: number) => {
  const sep = url.includes('?') ? '&' : '?';
  const bust = `${url}${sep}_=${Date.now()}`;
  return fetchFn(bust, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
};

const parseJson = async (res: Response): Promise<Record<string, unknown>> => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};

/** Provider A — api.country.is (CORS-friendly) */
const providerA: ProviderFn = async (fetchFn, timeoutMs) => {
  const start = Date.now();
  const url = _resolveEndpoint('a', '/');
  const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
  const data = await parseJson(res);
  return {
    countryCode: typeof data.country === 'string' ? data.country : null,
    ip: typeof data.ip === 'string' ? data.ip : null,
    source: 'a',
    latencyMs: Date.now() - start,
  };
};

/** Provider B — geojs.io (CORS-friendly) */
const providerB: ProviderFn = async (fetchFn, timeoutMs) => {
  const start = Date.now();
  const url = _resolveEndpoint('b', '/v1/ip/country.json');
  const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
  const data = await parseJson(res);
  return {
    countryCode: typeof data.country === 'string' ? data.country : null,
    ip: typeof data.ip === 'string' ? data.ip : null,
    source: 'b',
    latencyMs: Date.now() - start,
  };
};

/** Provider C — ipinfo.io (CORS-friendly) */
const providerC: ProviderFn = async (fetchFn, timeoutMs) => {
  const start = Date.now();
  const url = _resolveEndpoint('c', '/json');
  const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
  const data = await parseJson(res);
  return {
    countryCode: typeof data.country === 'string' ? data.country : null,
    ip: typeof data.ip === 'string' ? data.ip : null,
    source: 'c',
    latencyMs: Date.now() - start,
  };
};

/** Provider D — ifconfig.co (CORS-friendly) */
const providerD: ProviderFn = async (fetchFn, timeoutMs) => {
  const start = Date.now();
  const url = _resolveEndpoint('d', '/json');
  const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
  const data = await parseJson(res);
  return {
    countryCode: typeof data.country_iso === 'string' ? data.country_iso : null,
    ip: typeof data.ip === 'string' ? data.ip : null,
    source: 'd',
    latencyMs: Date.now() - start,
  };
};

export const ALL_PROVIDERS: ProviderFn[] = [providerA, providerB, providerC, providerD];

/** Быстрые провайдеры для периодической проверки (~0.5–1.5 сек) */
export const FAST_PROVIDERS: ProviderFn[] = [providerA, providerB];
