// 依次运行 package.json 里所有 check:* 脚本（包括类型检查），任何一项失败就以非零退出，上线前和每次改动后都跑这一条。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const names = Object.keys(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts).filter(name => name.startsWith('check') && name !== 'check:all')
const failed = []
for (const name of names) {
  const started = Date.now()
  const result = spawnSync('npm', ['run', '-s', name], { encoding: 'utf8', timeout: 300000 })
  const ok = result.status === 0
  console.log(`${ok ? '通过' : '失败'}  ${name}  ${((Date.now() - started) / 1000).toFixed(1)}s`)
  if (!ok) { failed.push(name); console.log((result.stdout + result.stderr).split('\n').slice(-15).join('\n')) }
}
if (failed.length) { console.error(`\n${failed.length} 项未通过：${failed.join('、')}`); process.exit(1) }
console.log(`\n全部 ${names.length} 项检查通过。`)
