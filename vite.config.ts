import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/screen-capture/' : '/',
  plugins: [react()],
  server: {
    port: 5176,
    strictPort: true,
    host: true,
    open: true,
  },
})
