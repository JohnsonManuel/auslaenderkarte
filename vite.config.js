import { defineConfig } from 'vite';

// GitHub Pages serves this site from https://<user>.github.io/auslaenderkarte/, so
// that build needs the subpath base. Vercel (and the dev server) serve from the
// domain root, so the root base is used there instead - detected via the VERCEL
// env var Vercel sets automatically during its build.
export default defineConfig(({ command }) => ({
  base: command === 'build' && !process.env.VERCEL ? '/auslaenderkarte/' : '/',
  // The app boots with top-level await; target a baseline that supports it.
  build: { target: 'es2022' },
}));
