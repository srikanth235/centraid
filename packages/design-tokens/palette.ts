// App-icon palette — saturated 8 that read well on graphite.
// `as const` so callers get exact-string color types rather than `string`.

export const palette = {
  amber: '#E89A3C',
  forest: '#5C8A4E',
  indigo: '#4E68DD',
  ochre: '#B47B3F',
  rose: '#E55772',
  slate: '#5C677D',
  teal: '#2EA098',
  violet: '#7C5BD9',
} as const;

export type Palette = typeof palette;
export type ColorKey = keyof Palette;
export type ColorHex = Palette[ColorKey];
