/** Mobile responsive layer dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'toggle.open': '打开详情',
  'toggle.close': '关闭详情',
} satisfies Record<string, string>

/** The mobile namespace key union. */
export type MobileKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'toggle.open': 'Open details',
  'toggle.close': 'Close details',
} satisfies Record<MobileKey, string>
