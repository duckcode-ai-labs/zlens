/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fontLicence } from '@zlens/ui/font-licence'

export default defineConfig({
  // fontLicence: Inter's licence ships beside the font files in dist/assets.
  plugins: [react(), tailwindcss(), fontLicence()],
  server: {
    port: 5174,
    // Proxy all /api/* requests to the running zlens notebook server
    // Start the server first: zlens notebook --no-open --port 3475
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3475',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The ZLens app for Snowflake ships the UI's source maps beside its minified JavaScript, as
    // Snowflake's app security review asks (the Dockerfile's builder sets ZLENS_UI_SOURCEMAP=1).
    // The npm package leaves them out to stay small.
    sourcemap: /^(1|true|on|yes)$/i.test(process.env.ZLENS_UI_SOURCEMAP ?? ''),
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/lang-sql',
            '@codemirror/language',
            '@codemirror/theme-one-dark',
          ],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  base: '/',
  test: {
    // Gives Node 20 the global `navigator` that Node 21+ has (see the file).
    setupFiles: ['./vitest.setup.ts'],
  },
})
