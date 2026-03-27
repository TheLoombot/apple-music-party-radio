import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'

const commitHash = (() => {
  if (process.env.VITE_COMMIT_SHA) return process.env.VITE_COMMIT_SHA.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'dev' }
})()

export default defineConfig(({ command }) => ({
  plugins: [react()],
  envDir: path.resolve(__dirname, '..'),  // read .env from project root
  base: command === 'build' ? '/apple-music-party-radio/' : '/',
  server: { port: 5173, host: true, allowedHosts: true },
  define: { __COMMIT__: JSON.stringify(commitHash) }
}))
