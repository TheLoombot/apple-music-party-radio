import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  test: {
    name: "client",
    environment: "jsdom",
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/__tests__/setup.ts"],
  },
  define: {
    // Stub env vars that the source modules read at import time
    "import.meta.env.VITE_APPLE_DEVELOPER_TOKEN": JSON.stringify("test-dev-token"),
    "import.meta.env.VITE_PARTYKIT_HOST": JSON.stringify("localhost:1999"),
    "import.meta.env.DEV": "false",
    "__COMMIT__": JSON.stringify("test"),
  },
})
