const STORAGE_KEY = 'gate:lastResult';
const TARGET = 'https://claude.ai';

type Verdict = 'allowed' | 'blocked' | 'unknown';
interface GateResult {
  verdict: Verdict;
  countryCode: string | null;
}

function isGranted(result: GateResult | null): boolean {
  return result?.verdict === 'allowed';
}

function render(result: GateResult | null) {
  if (result && isGranted(result)) {
    window.location.replace(TARGET);
    return;
  }

  const isBlocked = result?.verdict === 'blocked';
  const icon = document.getElementById('icon')!;
  const title = document.getElementById('title')!;
  const message = document.getElementById('message')!;
  const region = document.getElementById('region')!;
  const reason = document.getElementById('reason')!;

  icon.textContent = '🔒';
  title.textContent = isBlocked ? 'Включите VPN' : 'Проверьте VPN';
  message.textContent = isBlocked
    ? 'Похоже, вы забыли включить VPN. Перед началом работы убедитесь, что VPN включён и подключён к разрешённому региону.'
    : 'Не удалось подтвердить регион. Включите VPN, проверьте подключение и повторите попытку.';

  region.hidden = true;
  reason.hidden = true;
}

async function sendRecheck(): Promise<GateResult | null> {
  try {
    return await chrome.runtime.sendMessage({ type: 'RECHECK', force: true, fast: true });
  } catch {
    await chrome.runtime.sendMessage({ type: 'WAKE' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    return chrome.runtime.sendMessage({ type: 'RECHECK', force: true, fast: true });
  }
}

// Шлюз: проверка до любого контакта с Claude
void sendRecheck().then((result) => render(result ?? null));

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) {
    render(changes[STORAGE_KEY].newValue ?? null);
  }
});

document.getElementById('retry')!.addEventListener('click', async (e) => {
  const btn = e.target as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Проверяем…';
  try {
    const result = await sendRecheck();
    render(result ?? null);
  } catch {
    btn.textContent = 'Ошибка — попробуйте снова';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Проверить снова';
    }, 2000);
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Проверить снова';
});
