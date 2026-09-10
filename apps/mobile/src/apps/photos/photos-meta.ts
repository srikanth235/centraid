// THE APP'S OWN IDENTITY, IN ONE PLACE (#1015 Wave 2).
//
// The mark and the colour the room's `AppHeader` draws are the app's, not a
// screen's — two screens resolving them separately is how a header and a
// springboard tile come to disagree about which amber Photos is.

import { resolveAppMeta } from "../../lib/gateway";

export const PHOTOS_META = resolveAppMeta({
  id: "photos",
  name: "Photos",
  description: "Every photograph this vault holds.",
  iconKey: "Camera",
  colorKey: "amber",
});
