/** Базовые домены (apex) — поддомены любой глубины через regex */
export const DEFAULT_DOMAINS = [
  'claude.ai',
  'claude.com',
  'anthropic.com',
] as const;

export const ALLOWED_ENTRY_URL = 'https://claude.ai';

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Нормализует ввод в паттерн "domain" или "domain/path".
 *
 * Принимает:
 *   - полный URL: https://a.b.example.com/id01?q=1  → "example.com/id01"
 *   - хост + путь: example.com/path/to               → "example.com/path/to"
 *   - wildcard:    *.example.com                     → "example.com"
 *   - просто домен: example.com                      → "example.com"
 *
 * Домен нормализуется к apex (все субдомены покрываются через regex).
 * Путь сохраняется, query/fragment/trailing-slash обрезаются.
 */
export function normalizeDomain(input: string): string | null {
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

  if (!s || s.includes('*') || s.includes('/') || !DOMAIN_RE.test(s)) {
    return null;
  }

  if (pathname && pathname !== '/') {
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
    if (/[?#\s]/.test(pathname)) return null;
    return `${s}${pathname}`;
  }

  return s;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Строит DNR regexFilter для нормализованного паттерна.
 *   "domain"       → блокирует все пути домена + поддоменов
 *   "domain/path"  → блокирует префикс пути домена + поддоменов
 */
export function hostRegexForDomain(pattern: string): string {
  const slashIdx = pattern.indexOf('/');
  if (slashIdx === -1) {
    return `^https?://(?:[^/]+\\.)*${escapeRegex(pattern)}/`;
  }
  const host = pattern.slice(0, slashIdx);
  const path = pattern.slice(slashIdx);
  // После пути должны быть: другой сегмент (/), query (?), anchor (#) или конец URL.
  return `^https?://(?:[^/]+\\.)*${escapeRegex(host)}${escapeRegex(path)}(?:[/?#]|$)`;
}

/**
 * Проверяет, попадает ли URL (hostname + pathname) под один из паттернов.
 *   Паттерн "domain"      → совпадение по любому пути
 *   Паттерн "domain/path" → совпадение только если pathname = path или начинается с path/
 */
export function isGatedUrl(
  hostname: string,
  pathname: string,
  customDomains: string[],
): boolean {
  const host = hostname.toLowerCase();
  for (const pattern of [...DEFAULT_DOMAINS, ...customDomains]) {
    const slashIdx = pattern.indexOf('/');
    const d = slashIdx === -1 ? pattern : pattern.slice(0, slashIdx);
    const p = slashIdx === -1 ? null : pattern.slice(slashIdx);

    if (host !== d && !host.endsWith(`.${d}`)) continue;

    if (p === null) return true;
    if (pathname === p || pathname.startsWith(`${p}/`)) return true;
  }
  return false;
}

/** Обратная совместимость: проверка только по hostname (любой путь). */
export function isGatedHost(hostname: string, customDomains: string[]): boolean {
  return isGatedUrl(hostname, '/', customDomains);
}

export function getAllDomains(customDomains: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...DEFAULT_DOMAINS, ...customDomains]) {
    const n = normalizeDomain(d);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Chrome match patterns (один уровень *.) — для tabs.query */
export function tabQueryPatterns(domains: string[]): string[] {
  const patterns: string[] = [];
  for (const d of domains) {
    const host = d.includes('/') ? d.slice(0, d.indexOf('/')) : d;
    patterns.push(`*://${host}/*`, `*://*.${host}/*`);
  }
  return patterns;
}

export function formatDomainsPreview(customDomains: string[]): string {
  const custom = customDomains.length ? ` + ${customDomains.join(', ')}` : '';
  return `${DEFAULT_DOMAINS.join(', ')}${custom}`;
}
