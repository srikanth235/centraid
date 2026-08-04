import { isIconName } from "@centraid/design";
import type { IconName } from "@centraid/design";

// The adapter accepts the mobile call-site spelling, but every value resolves
// to the one shared semantic registry. Unknown names fail loudly so a new
// glyph cannot silently become an unrelated MoreHoriz icon.
const ALIASES: Record<string, IconName> = {
  "alert-circle": "AlertCircle",
  archive: "Archive",
  "arrow-left": "ArrowLeft",
  "bar-chart-2": "BarChart2",
  "battery-charging": "BatteryCharging",
  bell: "Bell",
  "book-open": "BookOpen",
  bookmark: "Bookmark",
  check: "Check",
  "chevron-down": "ChevronDown",
  "chevron-left": "ChevronLeft",
  "chevron-right": "ChevronRight",
  "chevrons-down": "ChevronsDown",
  clock: "Clock",
  cloud: "Cloud",
  "cloud-off": "CloudOff",
  copy: "Copy",
  cpu: "Cpu",
  download: "Download",
  "download-cloud": "Download",
  "edit-2": "Pencil",
  "edit-3": "Pencil",
  "file-text": "FileEdit",
  folder: "Folder",
  "folder-plus": "FolderPlus",
  grid: "Grid",
  heart: "Heart",
  home: "Home",
  image: "Image",
  info: "AlertCircle",
  layers: "Layers",
  list: "List",
  maximize: "Maximize",
  menu: "Menu",
  "message-circle": "MessageCircle",
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
  star: "Star",
  "trash-2": "Trash",
  "upload-cloud": "Upload",
  user: "User",
  "user-plus": "UserPlus",
  users: "Users",
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
