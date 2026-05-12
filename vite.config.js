import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load VITE_-prefixed vars from .env files (for local dev)
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_');
  // Also pick up VITE_-prefixed vars from process.env (for CI/CD like Netlify)
  const processEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('VITE_'))
  );
  const env = { ...fileEnv, ...processEnv };

  return {
    plugins: [react()],
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
    server: {
      host: true,
      port: 5174,
      open: true,
    },
    define: {
      // Only VITE_-prefixed vars are exposed via process.env in the browser bundle
      'process.env': env,
    },
  };
});
