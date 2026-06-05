import { ALL_PROVIDERS, type ProviderFn } from './providers';

export type { ProviderFn };
import { _blockedSet, _matchBlocked, _orderProviders } from './obfuscate';
import type {
  GeoResult,
  RegionGateConfig,
  RegionGateController,
  RegionGateResult,
  RegionGateVerdict,
} from './types';

const DEFAULT_BLOCKED = _blockedSet();
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_MIN_PROVIDERS = 2;
const DEFAULT_RECHECK_MS = 5 * 60 * 1000;

function resolveVerdict(
  results: GeoResult[],
  blockedCountries: Set<string>,
  minSuccessful: number
): { verdict: RegionGateVerdict; countryCode: string | null; reason: string } {
  const successful = results.filter((r) => r.countryCode !== null);

  if (successful.length < minSuccessful) {
    return {
      verdict: 'unknown',
      countryCode: null,
      reason: `Insufficient data: ${successful.length}/${minSuccessful} providers responded with country`,
    };
  }

  const votes = new Map<string, number>();
  for (const r of successful) {
    const code = r.countryCode!.toUpperCase();
    votes.set(code, (votes.get(code) ?? 0) + 1);
  }

  let topCode: string | null = null;
  let topVotes = 0;
  for (const [code, count] of votes) {
    if (count > topVotes) {
      topCode = code;
      topVotes = count;
    }
  }

  if (!topCode) {
    return { verdict: 'unknown', countryCode: null, reason: 'No consensus on country' };
  }

  if (_matchBlocked(topCode, blockedCountries)) {
    return {
      verdict: 'blocked',
      countryCode: topCode,
      reason: `Region ${topCode} is not supported`,
    };
  }

  return {
    verdict: 'allowed',
    countryCode: topCode,
    reason: 'Region check passed',
  };
}

async function runCheck(config: Required<Pick<RegionGateConfig, 'providerTimeoutMs' | 'minSuccessfulProviders' | 'fetchFn'>> & {
  blockedCountries: Set<string>;
  providers: ProviderFn[];
}): Promise<RegionGateResult> {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const seed = Date.now() % 997;
  const ordered = _orderProviders(config.providers, seed);

  const settled = await Promise.allSettled(
    ordered.map((provider) => provider(fetchFn, config.providerTimeoutMs))
  );

  const results: GeoResult[] = settled
    .filter((s): s is PromiseFulfilledResult<GeoResult> => s.status === 'fulfilled')
    .map((s) => s.value);

  const { verdict, countryCode, reason } = resolveVerdict(
    results,
    config.blockedCountries,
    config.minSuccessfulProviders
  );

  const ips = results.map((r) => r.ip).filter(Boolean);
  const ip = ips.length > 0 ? ips[0] : null;

  return {
    verdict,
    countryCode,
    ip,
    reason,
    sources: results,
    checkedAt: Date.now(),
  };
}

export function createRegionGate(userConfig: RegionGateConfig = {}): RegionGateController {
  const blockedCountries = new Set(
    (userConfig.blockedCountries ?? [...DEFAULT_BLOCKED]).map((c) => c.toUpperCase())
  );
  const providerTimeoutMs = userConfig.providerTimeoutMs ?? DEFAULT_TIMEOUT;
  const minSuccessfulProviders = userConfig.minSuccessfulProviders ?? DEFAULT_MIN_PROVIDERS;
  const recheckIntervalMs = userConfig.recheckIntervalMs ?? DEFAULT_RECHECK_MS;
  const fetchFn = userConfig.fetchFn ?? globalThis.fetch;
  const onVerdictChange = userConfig.onVerdictChange;

  let lastResult: RegionGateResult | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const providers = userConfig.providers ?? ALL_PROVIDERS;

  const checkConfig = {
    blockedCountries,
    providerTimeoutMs,
    minSuccessfulProviders,
    fetchFn,
    providers,
  };

  const check = async (): Promise<RegionGateResult> => {
    const result = await runCheck(checkConfig);
    const prev = lastResult?.verdict;
    lastResult = result;
    if (prev && prev !== result.verdict && onVerdictChange) {
      onVerdictChange(result);
    }
    return result;
  };

  const startPeriodicCheck = (): void => {
    if (intervalId) return;
    intervalId = setInterval(() => {
      void check();
    }, recheckIntervalMs);
  };

  const stopPeriodicCheck = (): void => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const dispose = (): void => {
    stopPeriodicCheck();
    lastResult = null;
  };

  return {
    check,
    startPeriodicCheck,
    stopPeriodicCheck,
    getLastResult: () => lastResult,
    dispose,
  };
}

export function isAccessGranted(result: RegionGateResult): boolean {
  return result.verdict === 'allowed';
}
