/** Домены Claude/Anthropic — ни один запрос не уходит до проверки VPN */
export const GATED_HOST_PATTERNS = [
  '^https?://([^/]+\\.)?claude\\.ai/',
  '^https?://([^/]+\\.)?claude\\.com/',
  '^https?://([^/]+\\.)?anthropic\\.com/',
] as const;

export const CLAUDE_URL_PATTERNS = [
  '*://claude.ai/*',
  '*://*.claude.ai/*',
  '*://claude.com/*',
  '*://*.claude.com/*',
  '*://anthropic.com/*',
  '*://*.anthropic.com/*',
] as const;

export const ALLOWED_ENTRY_URL = 'https://claude.ai';

