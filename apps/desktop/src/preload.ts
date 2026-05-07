// Bridges shared design tokens into the renderer.
// Renderer runs with contextIsolation=true and no node integration, so it
// can't `require()` directly. We expose plain JSON-cloneable token values
// via contextBridge and the renderer reads them off `window.CentraidTokens`.

import { contextBridge } from 'electron';
import * as tokens from '@centraid/design-tokens';

contextBridge.exposeInMainWorld('CentraidTokens', {
  apps: [...tokens.apps],
  colors: tokens.colors,
  fonts: tokens.fonts,
  icons: tokens.icons,
  palette: tokens.palette,
  radii: tokens.radii,
  spacing: tokens.spacing,
  type: tokens.type,
});
