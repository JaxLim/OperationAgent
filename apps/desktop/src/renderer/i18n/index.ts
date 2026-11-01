import type { Language } from '@operation-agent/contracts';
import { en } from './en';
import type { MessageKey } from './en';
import { zhCN } from './zh-CN';
import { ja } from './ja';

// Interface language. Pure lookups only: the saved choice lives in Express settings and reaches here as an argument.

export type { MessageKey };
export type Locale = 'en' | 'zh-CN' | 'ja';
export type Vars = Readonly<Record<string, string | number>>;
const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, 'zh-CN': zhCN, ja };
/** Each language is named in itself, so it can be found whatever the current language is. */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { en: 'English', 'zh-CN': '简体中文', ja: '日本語' };

/** `system` uses the operating system's language as Main reports it; anything unsupported falls back to English. */
export function resolveLocale(language: Language, system: string | undefined): Locale {
  if (language !== 'system') return language;
  const lower = (system ?? '').toLowerCase();
  return lower.startsWith('zh') ? 'zh-CN' : lower.startsWith('ja') ? 'ja' : 'en';
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const template = CATALOGS[locale][key];
  return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match) : template;
}
