import { useCallback } from 'react';
import { resolveLocale, translate } from './i18n';
import type { Locale, MessageKey, Vars } from './i18n';
import { useStore } from './state';

export type Translate = (key: MessageKey, vars?: Vars) => string;
export function useLocale(): Locale {
  return resolveLocale(useStore(s => s.settings?.language ?? 'system'), useStore(s => s.desktop?.app.locale));
}
export function useT(): Translate {
  const locale = useLocale();
  return useCallback((key, vars) => translate(locale, key, vars), [locale]);
}
