import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'

const commitHash = (() => {
  if (process.env.VITE_COMMIT_SHA) return process.env.VITE_COMMIT_SHA.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'dev' }
})()

export default defineConfig(() => ({
  plugins: [react()],
  envDir: path.resolve(__dirname, '..'),  // read .env from project root
  // Served from the apex `hat.fm` custom domain — base is `/` for both dev and build.
  // (Before the custom domain was set up this was '/apple-music-party-radio/' for builds.)
  base: '/',
  // fs.allow: the repo-root shared/ module (track-shape utilities) is imported
  // from client code; without this Vite's dev server refuses to serve files
  // outside the client directory.
  server: { port: 5173, host: true, allowedHosts: true, fs: { allow: [path.resolve(__dirname, '..')] } },
  // transformers.js (onnxruntime-web WASM) doesn't play well with esbuild
  // prebundling — exclude it so Vite serves it as-is.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  define: { __COMMIT__: JSON.stringify(commitHash) }
}))
