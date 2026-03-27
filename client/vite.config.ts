import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(__dirname, '..'),  // read .env from project root
  base: process.env.NODE_ENV === 'production' ? '/apple-music-party-radio/' : '/',
  server: { port: 5173 }
})
