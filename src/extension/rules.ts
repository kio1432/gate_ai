import { hostRegexForDomain } from './domains';

const RULESET_ID = 'block_claude';
const CUSTOM_RULE_BASE_ID = 10_000;

const SUBRESOURCE_TYPES: chrome.declarativeNetRequest.ResourceType[] = [
  chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
  chrome.declarativeNetRequest.ResourceType.SCRIPT,
  chrome.declarativeNetRequest.ResourceType.STYLESHEET,
  chrome.declarativeNetRequest.ResourceType.IMAGE,
  chrome.declarativeNetRequest.ResourceType.FONT,
  chrome.declarativeNetRequest.ResourceType.WEBSOCKET,
  chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
  chrome.declarativeNetRequest.ResourceType.PING,
  chrome.declarativeNetRequest.ResourceType.MEDIA,
  chrome.declarativeNetRequest.ResourceType.OTHER,
];

// Сериализация: вызовы из init() и storage.onChanged могут идти параллельно
let opQueue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): Promise<void> {
  opQueue = opQueue.then(task, task);
  return opQueue;
}

function buildCustomRules(domains: string[]): chrome.declarativeNetRequest.Rule[] {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  let id = CUSTOM_RULE_BASE_ID;

  for (const domain of domains) {
    const regexFilter = hostRegexForDomain(domain);
    rules.push({
      id: id++,
      priority: 2,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
        redirect: { extensionPath: '/blocked.html' },
      },
      condition: {
        regexFilter,
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
      },
    });
    rules.push({
      id: id++,
      priority: 2,
      action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
      condition: {
        regexFilter,
        resourceTypes: SUBRESOURCE_TYPES,
      },
    });
  }

  return rules;
}

/** Реальные id наших динамических правил (id >= base), без опоры на память */
async function existingCustomRuleIds(): Promise<number[]> {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.filter((r) => r.id >= CUSTOM_RULE_BASE_ID).map((r) => r.id);
}

/** Обновление с защитой от "Rule with id N does not have a unique ID" */
async function safeReplace(addRules: chrome.declarativeNetRequest.Rule[]): Promise<void> {
  const removeRuleIds = await existingCustomRuleIds();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch {
    // Сносим все наши правила и пробуем ещё раз
    const stale = await existingCustomRuleIds();
    if (stale.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: stale });
    }
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [], addRules });
  }
}

export function syncCustomDomainRules(customDomains: string[]): Promise<void> {
  return enqueue(() => safeReplace(buildCustomRules(customDomains)));
}

export function clearCustomDomainRules(): Promise<void> {
  return enqueue(async () => {
    const removeRuleIds = await existingCustomRuleIds();
    if (removeRuleIds.length === 0) return;
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  });
}

/**
 * Удаляет ВСЕ динамические правила, включая устаревшие от прежних версий
 * расширения (их id могли быть любыми и они переживают обновление → могут
 * вечно заворачивать claude.ai на blocked.html, минуя disableBlocking).
 */
export function purgeAllDynamicRules(): Promise<void> {
  return enqueue(async () => {
    const all = await chrome.declarativeNetRequest.getDynamicRules();
    if (all.length === 0) return;
    const removeRuleIds = all.map((r) => r.id);
    console.log('[BlockAI] purgeAllDynamicRules removing ids:', removeRuleIds);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  });
}

/** Диагностика: что реально активно в DNR прямо сейчас */
export async function dumpDnrState(tag: string): Promise<void> {
  try {
    const [dyn, enabled] = await Promise.all([
      chrome.declarativeNetRequest.getDynamicRules(),
      chrome.declarativeNetRequest.getEnabledRulesets(),
    ]);
    console.log(
      '[BlockAI] DNR[%s] enabledRulesets=%o dynamicRuleIds=%o',
      tag,
      enabled,
      dyn.map((r) => r.id)
    );
  } catch (e) {
    console.log('[BlockAI] DNR dump error', e);
  }
}

export async function enableBlocking(customDomains: string[] = []): Promise<void> {
  await syncCustomDomainRules(customDomains);
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: [RULESET_ID],
  });
  await waitRulesetState(true);
}

export async function disableBlocking(): Promise<void> {
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    disableRulesetIds: [RULESET_ID],
  });
  // Чистим ВСЕ динамические правила (включая мусор от старых версий), иначе
  // claude.ai продолжит заворачиваться на blocked.html при открытом шлюзе.
  await purgeAllDynamicRules();
  // КРИТИЧНО: updateEnabledRulesets может разрешить промис раньше, чем правило
  // реально снято с сетевого слоя. Если в этот момент blocked.html уйдёт на
  // Claude — статическое правило ещё успеет завернуть его обратно → петля.
  // Поэтому ждём подтверждения, что ruleset действительно выключен.
  await waitRulesetState(false);
}

/** Ждём, пока статический ruleset перейдёт в нужное состояние (enabled?) */
async function waitRulesetState(enabled: boolean, attempts = 20, stepMs = 25): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const list = await chrome.declarativeNetRequest.getEnabledRulesets();
      if (list.includes(RULESET_ID) === enabled) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
