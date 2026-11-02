// 在服务器上解除登录锁定：清除所有被锁的网络地址。
import { createAuth } from '../server/auth.mjs'
import { dataDirectory } from '../server/vite-storage-plugin.mjs'

const count = createAuth(dataDirectory()).unlockAll()
console.log(count ? `已解除 ${count} 个网络地址的锁定。` : '当前没有被锁定的网络地址。')
