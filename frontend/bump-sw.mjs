// bump-sw.mjs — запускается после `vite build`.
//
// Service worker обновляется браузером ТОЛЬКО когда меняется сам sw.js.
// Поскольку бандлы приложения (index-*.js) хэшируются, но sw.js не менялся
// между деплоями, у пользователей не срабатывал updatefound → не появлялся
// баннер «Вышла новая версия». При каждой сборке дописываем в начало
// dist/sw.js маркер сборки: байты файла меняются → браузер перекачивает SW →
// main.jsx показывает баннер обновления в том же запуске.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)))
const file = join(root, 'dist', 'sw.js')
if (!existsSync(file)) {
  console.warn('bump-sw: dist/sw.js not found — nothing to bump')
  process.exit(0)
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let s = readFileSync(file, 'utf8')
// заменяем старый маркер (если был), иначе вставляем в начало
const marker = `/* build: ${stamp} */\n`
s = s.replace(/^\/\* build: [A-Za-z0-9-]+ \*\/\n/, '')
writeFileSync(file, marker + s)
console.log('bump-sw: dist/sw.js -> build:', stamp)