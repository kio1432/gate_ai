const RULESET_ID = 'block_claude';

/** Статические правила в manifest — активны до запуска service worker */
export async function enableBlocking(): Promise<void> {
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: [RULESET_ID],
  });
}

export async function disableBlocking(): Promise<void> {
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    disableRulesetIds: [RULESET_ID],
  });
}
