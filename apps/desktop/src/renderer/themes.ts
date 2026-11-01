import { THEME_CANVAS } from '@operation-agent/contracts';
import type { ThemeId } from '@operation-agent/contracts';

// Named palettes. Canvas and text colours come from the contracts (Main paints the caption buttons with the same
// values); each palette adds its surface, accent and state colours. The CSS derives every other token from these.

export type Variant = 'light' | 'dark';
interface Palette { readonly surface: string; readonly accent: string; readonly accentInk: string; readonly ok: string; readonly warn: string; readonly danger: string }
export const THEME_NAMES: Readonly<Record<ThemeId, string>> = {
  operation: 'OperationAgent', nord: 'Nord', solarized: 'Solarized', 'rose-pine': 'Rosé Pine', 'tokyo-night': 'Tokyo Night',
  one: 'One', github: 'GitHub', gruvbox: 'Gruvbox',
};
/** The built-in palette keeps its hand-tuned tokens in app.css; only its accents are listed here for previews. */
const OPERATION_ACCENT: Readonly<Record<Variant, string>> = { light: '#2f62e6', dark: '#7ea2ff' };
const PALETTES: Readonly<Record<Exclude<ThemeId, 'operation'>, Readonly<Record<Variant, Palette>>>> = {
  nord: {
    light: { surface: '#f8f9fb', accent: '#5e81ac', accentInk: '#ffffff', ok: '#4f7a3a', warn: '#a0662a', danger: '#bf616a' },
    dark: { surface: '#3b4252', accent: '#88c0d0', accentInk: '#2e3440', ok: '#a3be8c', warn: '#ebcb8b', danger: '#bf616a' },
  },
  solarized: {
    light: { surface: '#fffbef', accent: '#268bd2', accentInk: '#fdf6e3', ok: '#859900', warn: '#b58900', danger: '#dc322f' },
    dark: { surface: '#073642', accent: '#268bd2', accentInk: '#fdf6e3', ok: '#859900', warn: '#b58900', danger: '#dc322f' },
  },
  'rose-pine': {
    light: { surface: '#fffaf3', accent: '#907aa9', accentInk: '#fffaf3', ok: '#286983', warn: '#d7827e', danger: '#b4637a' },
    dark: { surface: '#1f1d2e', accent: '#c4a7e7', accentInk: '#191724', ok: '#9ccfd8', warn: '#f6c177', danger: '#eb6f92' },
  },
  'tokyo-night': {
    light: { surface: '#e9e9ed', accent: '#2e7de9', accentInk: '#ffffff', ok: '#587539', warn: '#8c6c3e', danger: '#f52a65' },
    dark: { surface: '#24283b', accent: '#7aa2f7', accentInk: '#1a1b26', ok: '#9ece6a', warn: '#e0af68', danger: '#f7768e' },
  },
  one: {
    light: { surface: '#ffffff', accent: '#4078f2', accentInk: '#ffffff', ok: '#50a14f', warn: '#c18401', danger: '#e45649' },
    dark: { surface: '#2f343e', accent: '#61afef', accentInk: '#282c34', ok: '#98c379', warn: '#e5c07b', danger: '#e06c75' },
  },
  github: {
    light: { surface: '#f6f8fa', accent: '#0969da', accentInk: '#ffffff', ok: '#1a7f37', warn: '#9a6700', danger: '#d1242f' },
    dark: { surface: '#161b22', accent: '#4493f8', accentInk: '#0d1117', ok: '#3fb950', warn: '#d29922', danger: '#f85149' },
  },
  gruvbox: {
    light: { surface: '#f9f5d7', accent: '#076678', accentInk: '#fbf1c7', ok: '#79740e', warn: '#b57614', danger: '#9d0006' },
    dark: { surface: '#32302f', accent: '#83a598', accentInk: '#282828', ok: '#b8bb26', warn: '#fabd2f', danger: '#fb4934' },
  },
};

/** Colours for a small preview: canvas, text and accent. */
export function swatch(id: ThemeId, variant: Variant): { bg: string; text: string; accent: string; surface: string } {
  const canvas = THEME_CANVAS[id][variant];
  if (id === 'operation') return { ...canvas, accent: OPERATION_ACCENT[variant], surface: variant === 'light' ? '#ffffff' : '#242427' };
  const palette = PALETTES[id][variant];
  return { ...canvas, accent: palette.accent, surface: palette.surface };
}

const PROPERTIES = ['--bg', '--text', '--surface', '--accent', '--accent-ink', '--ok', '--warn', '--danger'] as const;
/** Sets the core tokens on the root element through the CSSOM (allowed by the style-src CSP) and marks it for derivation. */
export function applyPalette(root: HTMLElement, id: ThemeId, variant: Variant): void {
  if (id === 'operation') {
    for (const property of PROPERTIES) root.style.removeProperty(property);
    root.removeAttribute('data-palette');
    return;
  }
  const canvas = THEME_CANVAS[id][variant];
  const palette = PALETTES[id][variant];
  const values: Record<(typeof PROPERTIES)[number], string> = { '--bg': canvas.bg, '--text': canvas.text, '--surface': palette.surface,
    '--accent': palette.accent, '--accent-ink': palette.accentInk, '--ok': palette.ok, '--warn': palette.warn, '--danger': palette.danger };
  for (const property of PROPERTIES) root.style.setProperty(property, values[property]);
  root.setAttribute('data-palette', id);
}
