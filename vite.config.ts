import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    define: {
      // Map GEMINI_API_KEY from .env to process.env.API_KEY used by the frontend
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    server: {
      port: 5173,
      proxy: {
        '/outbound-call': 'http://localhost:8080',
        '/end-call':      'http://localhost:8080',
        '/twiml':         'http://localhost:8080',
        '/client-log':    { target: 'ws://localhost:8080', ws: true },
        '/media-stream':  { target: 'ws://localhost:8080', ws: true },
        '/openai-sim':    { target: 'ws://localhost:8080', ws: true },
      },
    },
  };
});
