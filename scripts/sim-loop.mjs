// Симуляция системы: фон (вердикт+gate+cooldown+grace+cache) + DNR + навигация
// вкладок. Цель — найти сценарий провайдеров, при котором возникает петля
// редиректов (много навигаций за короткое окно).

const UNKNOWN_GRACE = 3;
const CHECK_TTL_MS = 4000;
const REOPEN_COOLDOWN_MS = 5000;
const POLL_MS = 1000;

function makeBg() {
  return {
    gateOpen: false,
    unknownStreak: 0,
    reopenAllowedAt: 0,
    cachedResult: null,
    cachedAt: -1e9,
    dnrEnabled: true,
    storage: null, // последний stored verdict
  };
}

function effectiveVerdict(bg, raw) {
  if (raw === 'allowed') {
    bg.unknownStreak = 0;
    return 'allowed';
  }
  if (raw === 'blocked') {
    bg.unknownStreak = 0;
    return 'blocked';
  }
  if (bg.gateOpen) {
    bg.unknownStreak += 1;
    if (bg.unknownStreak < UNKNOWN_GRACE) return 'allowed';
  }
  return 'unknown';
}

function applyVerdict(bg, raw, now, log) {
  const base = effectiveVerdict(bg, raw);
  let wantOpen = base === 'allowed';
  if (wantOpen && !bg.gateOpen && now < bg.reopenAllowedAt) wantOpen = false;

  const stored = wantOpen || base !== 'allowed' ? base : 'unknown';
  bg.storage = stored;

  if (wantOpen !== bg.gateOpen) {
    bg.gateOpen = wantOpen;
    if (wantOpen) {
      bg.dnrEnabled = false;
    } else {
      bg.dnrEnabled = true;
      bg.reopenAllowedAt = now + REOPEN_COOLDOWN_MS;
    }
  }
  return stored;
}

function runCheck(bg, providerFn, now, force, log) {
  if (!force && bg.cachedResult && now - bg.cachedAt < CHECK_TTL_MS) {
    return bg.cachedResult;
  }
  const raw = providerFn(now);
  const eff = applyVerdict(bg, raw, now, log);
  bg.cachedResult = eff;
  bg.cachedAt = now;
  return eff;
}

// init на пробуждении SW. mode: 'force' (текущее) | 'restore' (фикс)
function swInit(bg, now, mode) {
  if (mode === 'restore') {
    const open = bg.storage === 'allowed';
    bg.gateOpen = open;
    bg.dnrEnabled = !open;
    // cache/cooldown сохраняем как есть
    return;
  }
  // 'force' — как сейчас в коде: безусловно закрыть
  bg.gateOpen = false;
  bg.dnrEnabled = true;
  bg.unknownStreak = 0;
  bg.cachedResult = null;
  bg.cachedAt = -1e9;
  bg.reopenAllowedAt = 0;
}

// Прогон: один tab, события каждые POLL_MS. providerFn(t)->'allowed'|'blocked'|'unknown'
function simulate(name, providerFn, durationMs, opts = {}) {
  const { swRestartEvery = 0, initMode = 'force' } = opts;
  const bg = makeBg();
  let tab = 'blocked'; // считаем, что пользователь упёрся в шлюз
  let navigations = 0;
  const navTimes = [];
  const trace = [];

  // первичная загрузка blocked.html — force
  runCheck(bg, providerFn, 0, true);

  for (let now = 0; now <= durationMs; now += POLL_MS) {
    // Моделируем выгрузку/пробуждение service worker
    if (swRestartEvery && now > 0 && now % swRestartEvery === 0) {
      swInit(bg, now, initMode);
      trace.push(`${now} SW restart (init=${initMode}) -> dnr=${bg.dnrEnabled}`);
    }
    // Текущая страница делает свою проверку
    if (tab === 'blocked') {
      const v = runCheck(bg, providerFn, now, false);
      if (v === 'allowed') {
        // blocked.html уходит на claude
        tab = 'claude';
        navigations++; navTimes.push(now);
        trace.push(`${now} blocked->claude`);
        // навигация на claude: если DNR включён — мгновенный редирект назад
        if (bg.dnrEnabled) {
          tab = 'blocked';
          navigations++; navTimes.push(now);
          trace.push(`${now} claude->blocked (DNR)`);
          // blocked.html onload force-проверка
          runCheck(bg, providerFn, now, true);
        } else {
          // claude onload: content триггерит проверку (non-force)
          runCheck(bg, providerFn, now, false);
        }
      }
    } else {
      // claude: content триггерит проверку
      const v = runCheck(bg, providerFn, now, false);
      if (v !== 'allowed') {
        tab = 'blocked';
        navigations++; navTimes.push(now);
        trace.push(`${now} claude->blocked`);
        runCheck(bg, providerFn, now, true);
      }
    }
  }

  // Детектор петли: >6 навигаций за любое окно 10с
  let loop = false;
  for (let i = 0; i < navTimes.length; i++) {
    const windowNavs = navTimes.filter((t) => t >= navTimes[i] && t < navTimes[i] + 10000).length;
    if (windowNavs > 6) { loop = true; break; }
  }

  console.log(`\n=== ${name} ===`);
  console.log(`навигаций: ${navigations}, петля: ${loop ? 'ДА ❌' : 'нет ✅'}`);
  if (loop) console.log(trace.slice(0, 30).join('\n'));
  return loop;
}

// Сценарии провайдеров
const scenarios = [];

// 1. Стабильно allowed (VPN ок)
scenarios.push(['stable allowed', () => 'allowed']);

// 2. Стабильно blocked (RU без VPN)
scenarios.push(['stable blocked', () => 'blocked']);

// 3. RU -> через 8с включили VPN (стабильный allowed)
scenarios.push(['RU then VPN@8s', (t) => (t < 8000 ? 'blocked' : 'allowed')]);

// 4. Провайдеры РАСХОДЯТСЯ: чередование allowed/blocked каждую проверку
scenarios.push(['flap allowed/blocked', (t) => (Math.floor(t / 1000) % 2 ? 'allowed' : 'blocked')]);

// 5. allowed с редкими unknown (флаки-сеть)
scenarios.push(['allowed + unknown blips', (t) => (Math.floor(t / 1000) % 4 === 0 ? 'unknown' : 'allowed')]);

// 6. Чередование allowed/unknown каждую секунду
scenarios.push(['flap allowed/unknown', (t) => (Math.floor(t / 1000) % 2 ? 'allowed' : 'unknown')]);

// 7. allowed, затем VPN-дроп -> blocked на 3с -> снова allowed (мерцание VPN)
scenarios.push(['vpn drop blips', (t) => {
  const sec = Math.floor(t / 1000);
  return sec % 6 < 1 ? 'blocked' : 'allowed';
}]);

let anyLoop = false;
for (const [name, fn] of scenarios) {
  if (simulate(name, fn, 60000)) anyLoop = true;
}

// Ключевой тест: стабильный VPN + выгрузка SW каждые 25с
console.log('\n--- SW-restart тесты (стабильный allowed) ---');
if (simulate('allowed + SW restart, init=force (ТЕКУЩЕЕ)', () => 'allowed', 120000, { swRestartEvery: 25000, initMode: 'force' })) anyLoop = true;
const fixedLoop = simulate('allowed + SW restart, init=restore (ФИКС)', () => 'allowed', 120000, { swRestartEvery: 25000, initMode: 'restore' });

console.log(`\n\nИТОГ: ${anyLoop ? 'ЕСТЬ петля ❌' : 'петель не найдено ✅'}`);
process.exit(anyLoop ? 1 : 0);
