import { resolve } from 'node:path'
import { dataDirectory } from '../server/vite-storage-plugin.mjs'

const args = process.argv.slice(2)
const directoryFlag = args.indexOf('--directory')
const allowed = args.every((value, index) => value === '--confirm' || value === '--directory' || index === directoryFlag + 1 && directoryFlag >= 0)
if (!allowed || directoryFlag >= 0 && (!args[directoryFlag + 1] || args[directoryFlag + 1].startsWith('--'))) {
  console.error('用法：node scripts/migrate-database.mjs [--directory 本机资料目录] --confirm')
  process.exitCode = 1
} else if (!args.includes('--confirm')) {
  console.log('本次没有打开或修改本人资料。请先停止网页服务；确认迁移时，在命令末尾加上 --confirm。迁移会保留原文件并额外备份，不读取或搬运钥匙串。')
} else {
  const folder = directoryFlag >= 0 ? resolve(args[directoryFlag + 1]) : dataDirectory()
  try {
    const { migrateDatabase } = await import('../server/database-migration.mjs')
    const result = migrateDatabase(folder, { confirmed: true })
    console.log('迁移完成。原文件保留，密钥仍在本机钥匙串。')
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(`迁移未完成：${error.message}`)
    process.exitCode = 1
  }
}
