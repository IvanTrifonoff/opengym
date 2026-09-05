// api/demo-pow.js — доказательство работы (антибот для кнопки «Открыть демо-клуб»).
//
// Идея: перед выдачей токена сервер требует, чтобы клиент затратил ~2^16
// sha256-операций (несколько десятков мс — незаметно человеку, дорого боту,
// который хочет наплодить тысячи сессий). Сервер не хранит состояние:
// challenge — это случайная строка из ответа POST /api/demo/challenge,
// решение — nonce, при котором sha256(challenge + nonce) начинается с N нулевых
// hex-символов. Функции чистые — покрыты юнит-тестами без БД.
import crypto from 'node:crypto';

// sha256 в hex — серверная версия (фронт считает то же самое через WebCrypto).
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

// Проверка решения PoW: hex-префикс из `difficulty` нулей.
// difficulty — число hex-символов (0..8); 4 = 2^16 хэшей в среднем.
export function verifyPow({ challenge, nonce, difficulty }) {
  const d = Math.max(0, Math.min(8, difficulty | 0));
  if (!challenge || typeof nonce !== 'string') return false;
  if (d === 0) return true; // difficulty 0 — проверка выключена (тесты/локально)
  return sha256Hex(challenge + nonce).slice(0, d) === '0'.repeat(d);
}

// Решение PoW (серверная версия для тестов; фронт делает то же в браузере).
export function solvePow(challenge, difficulty, maxIters = 5_000_000) {
  const d = Math.max(0, Math.min(8, difficulty | 0));
  if (d === 0) return '0';
  const target = '0'.repeat(d);
  for (let nonce = 0; nonce < maxIters; nonce++) {
    if (sha256Hex(challenge + nonce).slice(0, d) === target) return String(nonce);
  }
  return null;
}

// Origin-проверка: POST /api/demo/token и /api/demo/enter принимают запросы
// только с разрешённых origins (CSRF-защита). Пустой Origin (curl, тесты)
// пропускаем — главный барьер ботов это PoW + лимиты сессий.
export function originAllowed(origin, allowedOrigins) {
  if (!origin) return true;
  const list = (allowedOrigins || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true; // allowlist не задана — не мешаем (дефолт задаёт compose)
  return list.includes(String(origin).trim().toLowerCase());
}