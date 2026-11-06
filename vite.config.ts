import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // относительные пути: сборка работает на любом статическом хостинге (HashRouter)
})
