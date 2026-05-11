import type { AppMetaResolved } from '@centraid/design-tokens';

// Shared prop shape for the legacy native-RN built-in app screens. These
// screens are no longer reachable from the home grid as of the WebView
// shell (issue #14, Phase B) and are scheduled for retirement in a
// follow-up. They live on for the moment so the codebase still compiles
// without a wholesale delete.
export interface AppComponentProps {
  app: AppMetaResolved;
}
