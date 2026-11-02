import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// @ts-expect-error 本机保存使用Node内置模块，由独立断言核对。
import localStoragePlugin from './server/vite-storage-plugin.mjs'

export default defineConfig({
  plugins: [react(), tailwindcss(), localStoragePlugin()],
  // 只监听本机，外部访问经 Caddy 转发并先通过登录；转发来的 Host 是服务器地址或域名，不能再用主机名白名单拦截。
  preview: { allowedHosts: true },
})
