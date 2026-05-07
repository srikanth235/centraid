// Metro converts asset imports into a number (asset module id) at runtime,
// but TS needs to know the type. Cover the formats we actually import.

declare module '*.ttf' {
  const asset: number;
  export default asset;
}
declare module '*.otf' {
  const asset: number;
  export default asset;
}
declare module '*.png' {
  const asset: number;
  export default asset;
}
