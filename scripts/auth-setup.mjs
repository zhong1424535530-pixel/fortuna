// 在服务器上绑定谷歌验证器：终端显示二维码，扫码后输入 6 位数字确认才保存。
import { createInterface } from 'node:readline/promises'
import qrcode from 'qrcode-terminal'
import { createAuth, matchStep, newSecret, otpauthUri } from '../server/auth.mjs'
import { dataDirectory } from '../server/vite-storage-plugin.mjs'

const folder = dataDirectory()
const auth = createAuth(folder)
const rl = createInterface({ input: process.stdin, output: process.stdout })
try {
  if (auth.bound()) {
    console.log(`已绑定过动态码（用户名：${auth.username()}）。重新绑定会让所有已登录的设备立即退出。`)
    if ((await rl.question('输入 yes 继续：')).trim().toLowerCase() !== 'yes') { console.log('已取消，原绑定不变。'); process.exit(0) }
  }
  const secret = newSecret()
  console.log('\n用谷歌验证器（Google Authenticator）扫描下面的二维码（需要终端至少 72 列 × 38 行，显示不全请拉大窗口后重新运行）：\n')
  qrcode.generate(otpauthUri(secret), { small: false })
  console.log(`\n无法扫码时，选择"输入设置密钥"，手动填入：${secret.match(/.{1,4}/g).join(' ')}\n（账号随意，类型选"基于时间"）\n`)
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = (await rl.question('输入验证器上显示的 6 位数字：')).replace(/\s/g, '')
    const step = matchStep(secret, code, -1, Date.now())
    if (step === null) { console.log('数字不对，请等验证器刷新后再试。'); continue }
    auth.bind(secret, step)
    console.log(`\n绑定完成。登录用户名：${auth.username()}（可在网页"设置"里修改）。`)
    process.exit(0)
  }
  console.log('连续输错 5 次，未保存。请重新运行 sudo investment-bind。')
  process.exitCode = 1
} finally { rl.close() }
