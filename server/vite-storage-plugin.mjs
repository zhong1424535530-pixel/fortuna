import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceApi } from './workspace-api.mjs'
import { createAuth } from './auth.mjs'
import { clearStaleWriterLock, databaseLockPath, ensureDatabase } from './database.mjs'

// 资料文件夹：可用 INVESTMENT_DATA_DIR 指定；默认 Mac 用"应用程序支持"，Linux 等用 ~/.local/share。
export function dataDirectory() {
  if (process.env.INVESTMENT_DATA_DIR) return process.env.INVESTMENT_DATA_DIR
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, 'PersonalInvestmentDashboard')
}

export default function localStoragePlugin() {
  const auth = createAuth(dataDirectory())
  const middleware = createWorkspaceApi(dataDirectory(), { auth })
  let scheduler
  const install = server => {
    const folder = dataDirectory()
    try { if (clearStaleWriterLock(folder)) console.warn('[启动] 已清除上次异常退出残留的写入锁。') } catch (error) { console.error(`[启动] 写入锁清除失败：${error.message}`) }
    try {
      const mode = ensureDatabase(folder)
      if (mode === 'created') console.log('[启动] 新资料目录，已创建资料库 portfolio.sqlite。')
      if (mode === 'legacy') console.warn('[启动] 发现旧版 JSON 资料尚未迁移，仍按旧方式保存（走势会被压缩且没有每日完整备份）。请停止服务后运行：npm run migrate:database -- --confirm')
    } catch (error) { console.error(`[启动] 资料库创建失败：${error.message}`) }
    if (existsSync(databaseLockPath(folder))) console.warn('[启动] 发现资料维护锁（迁移或恢复可能中途失败），保存功能会暂停，请先核对资料后手动删除 database-maintenance.lock 目录。')
    // 写入都是同步完成的，信号只会在两次写入之间处理，所以直接退出不会截断文件；退出时会关闭资料库并清理使用标记。
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => process.exit(0))
    if (!auth.bound()) console.log('[登录] 尚未绑定动态码，所有页面都无法登录。请在服务器上运行：sudo investment-bind')
    server.middlewares.use((request, response, next) => request.url?.startsWith('/api/') ? middleware(request, response) : next())
    scheduler ??= middleware.startScheduler()
  }
  return { name: 'personal-local-storage', configureServer: install, configurePreviewServer: install }
}
