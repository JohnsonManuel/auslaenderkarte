import { defineConfig } from 'vite';

// On GitHub Pages the site is served from https://<user>.github.io/auslaenderkarte/,
// so the production build needs that base path. The dev server stays at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/auslaenderkarte/' : '/',
  // The app boots with top-level await; target a baseline that supports it.
  build: { target: 'es2022' },
}));
