import { defineConfig, type Plugin } from 'vite';

// The built bundle runs with the strict policy: no network at all and no inline styles.
// Dev mode keeps the relaxed policy from index.html because Vite injects <style> tags
// and needs its HMR websocket.
const STRICT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

function strictCsp(): Plugin {
  return {
    name: 'strict-csp',
    apply: 'build',
    transformIndexHtml: html => html.replace(/(http-equiv="Content-Security-Policy" content=")[^"]*"/, `$1${STRICT_CSP}"`)
      .replace(/\s*<!-- Offline prototype:.*?-->/, ''),
  };
}

// No React plugin: TSX is compiled by Vite's built-in transform using tsconfig "jsx": "react-jsx".
export default defineConfig({
  base: './',
  plugins: [strictCsp()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2023' },
});
