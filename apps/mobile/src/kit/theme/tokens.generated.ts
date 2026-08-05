// GENERATED — do not edit by hand.
// Source: @centraid/design#toNativeTheme
// Regenerate: bun run generate:theme
//
// Native values are lowered from @centraid/design/src/native.ts.  They are
// concrete: no CSS parser, var(), calc(), color-mix(), or runtime overrides.

export const lightPalette = {
  accent: '#141414',
  accentDeep: '#141414',
  accentDeepHover: '#000000',
  accentFill: '#141414',
  accentLight: '#3D3D3B',
  accentSoft: 'rgba(20,20,20,.08)',
  accentText: '#141414',
  appIdentityText: '#141414',
  bg: '#FDFDFC',
  bgChrome: '#F5F4F2',
  bgElev: '#F5F4F2',
  bgHover: '#f1f1f0',
  bgPress: '#e8e8e7',
  bgSel: 'rgba(45,75,168,.12)',
  bgSunken: '#F9F8F6',
  cAmber: '#904e46',
  cForest: '#397247',
  cIndigo: '#635a93',
  cOchre: '#845922',
  cRose: '#8c4c61',
  cSlate: '#3e6596',
  cTeal: '#00707e',
  cViolet: '#7a5283',
  danger: '#9a3b2e',
  focusRingColor: '#4A67C8',
  line: '#EFEEEB',
  lineSel: 'rgba(45,75,168,.42)',
  lineStrong: '#E5E4E1',
  link: '#2D4BA8',
  net: '#9A3B2E',
  onAccent: '#FDFDFC',
  onStage: '#EDEDEC',
  onStageSoft: '#9A9A98',
  scrim: 'rgba(26,24,21,0.3)',
  shadowLg: '0 24px 48px -16px rgba(20,20,20,.16)',
  shadowMd: '0 8px 24px -8px rgba(20,20,20,.10)',
  shadowSm: '0 1px 2px rgba(20,20,20,.06)',
  skel: '#E4E3E0',
  stage: '#0B0B0B',
  stageLine: '#2A2A29',
  stageSunken: '#1A1A19',
  success: '#3a6540',
  text: '#141414',
  textDisabled: '#9C9C99',
  textFaint: '#6C6C69',
  textGhost: '#888885',
  textInv: '#FDFDFC',
  textSoft: '#5A5A58',
  toneCool: '#FBFCFC',
  toneMat: '#F0EFED',
  toneNeutral: '#FDFDFC',
  tonePaper: '#FCFBF8',
  toneWarm: '#FDFBF7',
  warning: '#7c5619',
} as const;

export const darkPalette = {
  accent: '#EDEDEC',
  accentDeep: '#EDEDEC',
  accentDeepHover: '#FFFFFF',
  accentFill: '#EDEDEC',
  accentLight: '#C8C8C6',
  accentSoft: 'rgba(237,237,236,.08)',
  accentText: '#EDEDEC',
  appIdentityText: '#EDEDEC',
  bg: '#0E0E0E',
  bgChrome: '#121211',
  bgElev: '#171716',
  bgHover: '#191919',
  bgPress: '#222222',
  bgSel: 'rgba(157,176,240,.12)',
  bgSunken: '#121211',
  cAmber: '#d78f85',
  cForest: '#7bb587',
  cIndigo: '#a39bda',
  cOchre: '#c99b65',
  cRose: '#d48da2',
  cSlate: '#7ea7dc',
  cTeal: '#58b4c4',
  cViolet: '#be92c8',
  danger: '#e08878',
  focusRingColor: '#8098E8',
  line: '#1B1B1A',
  lineSel: 'rgba(157,176,240,.42)',
  lineStrong: '#232322',
  link: '#9DB0F0',
  net: '#E08878',
  onAccent: '#FDFDFC',
  onStage: '#EDEDEC',
  onStageSoft: '#9A9A98',
  scrim: 'rgba(0,0,0,0.62)',
  shadowLg: '0 30px 70px -24px rgba(0,0,0,.7)',
  shadowMd: '0 12px 30px -14px rgba(0,0,0,.6)',
  shadowSm: '0 1px 0 rgba(0,0,0,.4)',
  skel: '#1E1E1D',
  stage: '#0B0B0B',
  stageLine: '#2A2A29',
  stageSunken: '#1A1A19',
  success: '#7fb588',
  text: '#EDEDEC',
  textDisabled: '#565654',
  textFaint: '#878785',
  textGhost: '#656563',
  textInv: '#0E0E0E',
  textSoft: '#9A9A98',
  toneCool: '#0D0E0F',
  toneMat: '#0A0A0A',
  toneNeutral: '#0E0E0E',
  tonePaper: '#12110E',
  toneWarm: '#131110',
  warning: '#d9a75b',
} as const;

export const radii = {
  lg: 12,
  md: 7,
  pill: 999,
  sm: 4,
  xl: 12,
  xs: 0,
} as const;

// The one rule weight. A FULL point, never `StyleSheet.hairlineWidth` —
// see packages/design/src/borders.ts for why.
export const borders = {
  hairline: 1,
} as const;

export const spacing = {
  '1': 4,
  '2': 8,
  '3': 12,
  '4': 16,
  '5': 24,
  '6': 32,
} as const;

export const metrics = {
  control: 34,
  row: 44,
  segmented: 28,
  stem: 240,
} as const;

export const density = {
  "comfortable": {
    "pad": 16,
    "row": 44
  },
  "compact": {
    "pad": 12,
    "row": 38
  },
  "dense": {
    "pad": 8,
    "row": 34
  }
} as const;

export const fonts = {
  display: {
    regular: 'InstrumentSerif_400Regular',
  },
  mono: {
    medium: 'DMMono_500Medium',
    regular: 'DMMono_400Regular',
  },
  sans: {
    medium: 'InstrumentSans_500Medium',
    regular: 'InstrumentSans_400Regular',
  },
  serif: {
    regular: 'SourceSerif4_400Regular',
  },
} as const;

export const type = {
  body: { family: 'sans', fontSize: 17, lineHeight: 24, weight: '400' },
  bodyStrong: { family: 'sans', fontSize: 17, lineHeight: 24, weight: '500' },
  control: { family: 'sans', fontSize: 13, lineHeight: 17, weight: '500' },
  display: { family: 'display', fontSize: 27, lineHeight: 32, weight: '400', letterSpacing: -0.27 },
  eyebrow: { family: 'sans', fontSize: 13, lineHeight: 17, weight: '400', letterSpacing: 0.78, textTransform: 'uppercase' },
  mono: { family: 'mono', fontSize: 12.5, lineHeight: 18, weight: '400', fontVariant: ['tabular-nums'] },
  reading: { family: 'serif', fontSize: 17.5, lineHeight: 31, weight: '400' },
  small: { family: 'sans', fontSize: 15, lineHeight: 21, weight: '400' },
  smallStrong: { family: 'sans', fontSize: 15, lineHeight: 21, weight: '500' },
  title: { family: 'sans', fontSize: 22, lineHeight: 28, weight: '500' },
} as const;

// The horizontal page inset every screen uses — NOT a `spacing` rung.
// See packages/design/src/density.ts#pageMargin for why 18 is off the scale.
export const pageMargin = 18;

export const targetMin = {"coarse":48,"fine":32} as const;
export const durations = {"one":140,"two":280} as const;
