// 检查英文覆盖：源码里 t('中文')、new Error('中文')、ConnectionError('中文') 的字面量必须有英文，否则列出。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { translate } from '../src/i18n.ts'

const CJK = /[一-鿿]/
const files = ['src', 'server'].flatMap(dir => readdirSync(dir, { recursive: true }).map(f => join(dir, String(f)))).filter(f => /\.(tsx?|mjs)$/.test(f) && !/i18n/.test(f))
const call = /\b(?:t|Error|ConnectionError)\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g
const missing = new Set()
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const [, , text] of source.matchAll(call)) {
    if (!CJK.test(text) || text.includes('${')) continue
    const plain = text.replace(/\\n/g, '\n').replace(/\\'/g, "'")
    if (CJK.test(translate(plain))) missing.add(`${file}: ${plain}`)
  }
}
if (missing.size) { console.error(`${missing.size} 条文字没有英文：\n` + [...missing].join('\n')); process.exit(1) }
console.log('英文覆盖完整')
