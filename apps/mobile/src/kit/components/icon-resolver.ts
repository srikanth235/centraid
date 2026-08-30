import { isIconName } from "@centraid/design";
import type { IconName } from "@centraid/design";

// The adapter accepts the mobile call-site spelling, but every value resolves
// to the one shared semantic registry. Unknown names fail loudly so a new
// glyph cannot silently become an unrelated MoreHoriz icon.
const ALIASES: Record<string, IconName> = {
  activity: "Activity",
  "alert-circle": "AlertCircle",
  archive: "Archive",
  "arrow-left": "ArrowLeft",
  // The composer's send affordance; the registry spells the verb, not the glyph.
  "arrow-up": "Send",
  "bar-chart-2": "BarChart2",
  "battery-charging": "BatteryCharging",
  bell: "Bell",
  "book-open": "Book",
  bookmark: "Bookmark",
  // The blueprint shelves' semantic names (drive-copy, view-copy). Each maps
  // to the registry glyph the same row already draws on the web, not to a
  // lookalike: an alias that guessed would be the silent substitution this
  // resolver's loud failure exists to prevent.
  capabilities: "Sliders",
  filing: "FolderPlus",
  Inbox: "Archive",
  locker: "Lock",
  names: "AddressBook",
  newdoc: "FileEdit",
  scan: "Camera",
  storage: "Database",
  check: "Check",
  "check-circle": "CheckCircle",
  "chevron-down": "ChevronDown",
  "chevron-left": "ChevronLeft",
  "chevron-right": "ChevronRight",
  "chevrons-down": "ChevronsDown",
  clock: "Clock",
  cloud: "Cloud",
  "cloud-off": "CloudOff",
  copy: "Copy",
  cpu: "Cpu",
  // Money, as the registry spells it — there is one currency glyph and it is
  // not denominated in dollars.
  "dollar-sign": "Coin",
  download: "Download",
  "download-cloud": "Download",
  "edit-2": "Pencil",
  "edit-3": "Pencil",
  file: "FileEdit",
  "file-text": "FileEdit",
  folder: "Folder",
  "folder-plus": "FolderPlus",
  grid: "Grid",
  // "Free up vault" is about how much room is left, not about a disk.
  "hard-drive": "Gauge",
  headphones: "Music",
  heart: "Heart",
  home: "Home",
  image: "Image",
  info: "AlertCircle",
  layers: "Layers",
  list: "List",
  "map-pin": "Pin",
  maximize: "Maximize",
  menu: "Menu",
  "message-circle": "MessageCircle",
  // The viewer's floating overflow chip. Horizontal, not vertical: it sits in a
  // round chip on the stage, where a vertical run of dots reads as a handle.
  "more-horizontal": "MoreHoriz",
  "more-vertical": "MoreVert",
  paperclip: "Paperclip",
  play: "Play",
  plus: "Plus",
  "rotate-ccw": "Reset",
  search: "Search",
  settings: "Settings",
  share: "Share",
  shield: "Shield",
  smartphone: "Smartphone",
  // The composer stop control while a turn is streaming.
  square: "Stop",
  star: "Star",
  "trash-2": "Trash",
  "upload-cloud": "Upload",
  user: "User",
  "user-plus": "UserPlus",
  users: "Users",
  video: "Video",
  x: "X",
  "x-circle": "XCircle",
  zap: "Bolt",
  "zap-off": "BoltOff",
};

export function resolveIconName(name: string): IconName {
  if (isIconName(name)) return name;
  const alias = ALIASES[name];
  if (alias) return alias;
  throw new Error(`Unknown mobile icon name: ${name}`);
}
