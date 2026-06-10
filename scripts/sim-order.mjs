// Моделируем КРИТИЧЕСКОЕ окно рассинхрона: запись вердикта в storage vs
// переключение DNR, при N вкладках, реагирующих на запись storage.
//
// Когда шлюз ОТКРЫВАЕТСЯ:
//  - storage-first (старый код): пишем allowed -> вкладки blocked.html сразу
//    уходят на claude, но DNR ещё ВКЛЮЧЁН -> claude заворачивается обратно на
//    blocked.html -> каждая такая вкладка делает force-проверку -> снова
//    allowed -> снова прыжок ... петля, тем хуже чем больше вкладок.
//  - dnr-first (фикс): сначала выключаем DNR, потом пишем allowed -> переход на
//    claude уже не заворачивается.

function run(mode, nTabs) {
  let dnrEnabled = true; // gate закрыт
  let storage = 'blocked';
  let bounces = 0;

  // Вкладки на blocked.html
  const tabs = Array.from({ length: nTabs }, () => ({ url: 'blocked' }));

  // applyVerdict при ОТКРЫТИИ шлюза
  function open() {
    if (mode === 'storage-first') {
      storage = 'allowed';
      reactAll();          // вкладки реагируют, DNR ещё включён
      dnrEnabled = false;  // (await disableBlocking завершился позже)
    } else {
      dnrEnabled = false;  // DNR off ПЕРВЫМ
      storage = 'allowed';
      reactAll();
    }
  }

  // Реакция вкладок на storage. Ограничим глубину, чтобы поймать петлю.
  let depth = 0;
  function reactAll() {
    depth++;
    if (depth > 50) return; // защита: считаем это петлёй
    for (const tab of tabs) {
      if (tab.url === 'blocked' && storage === 'allowed') {
        tab.url = 'claude';
        if (dnrEnabled) {
          // DNR заворачивает claude -> blocked
          tab.url = 'blocked';
          bounces++;
          // blocked.html onload -> force проверка -> снова allowed -> реакция
          reactAll();
        }
      }
    }
  }

  open();
  const looped = depth > 50 || bounces > nTabs * 3;
  console.log(
    `mode=${mode.padEnd(13)} tabs=${nTabs}  bounces=${bounces}  ${looped ? 'ПЕТЛЯ ❌' : 'ок ✅'}`
  );
  return looped;
}

let bad = false;
console.log('--- открытие шлюза, N вкладок blocked.html ---');
for (const n of [1, 3, 10]) {
  if (run('storage-first', n)) bad = true; // старый код
}
console.log('');
let fixedBad = false;
for (const n of [1, 3, 10]) {
  if (run('dnr-first', n)) fixedBad = true; // фикс
}

console.log(`\nСтарый порядок: ${bad ? 'петлит ❌' : 'ок'}`);
console.log(`Новый порядок:  ${fixedBad ? 'петлит ❌' : 'без петель ✅'}`);
process.exit(fixedBad ? 1 : 0);
