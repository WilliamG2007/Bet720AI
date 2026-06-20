import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    css: {
      postcss: './postcss.config.js',
    },
    server: {
      proxy: {
        // Proxy football-data.org through the dev server to bypass CORS.
        // football-data returns ACAO 'http://localhost' (no port) which the
        // browser rejects for localhost:5173, so we go server-side instead.
        '/fd-api': {
          target: 'https://api.football-data.org/v4',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/fd-api/, ''),
          headers: {
            'X-Auth-Token': env.VITE_FOOTBALL_API_KEY || '',
          },
        },
      },
    },
  }
})
