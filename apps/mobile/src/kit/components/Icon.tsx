import React from "react";
import Svg, { Path } from "react-native-svg";

import { icons, isIconName } from "@centraid/design";
import type { IconName } from "@centraid/design";

// Compatibility names cover the former Icon call-site vocabulary while
// keeping the artwork in the shared design registry. New code should use the
// PascalCase IconName directly; this adapter lets the migration land without
// leaving a second glyph source in the mobile bundle.
const ALIASES: Record<string, IconName> = {
  "alert-circle": "AlertCircle",
  archive: "Folder",
  "arrow-left": "ArrowLeft",
  "bar-chart-2": "Activity",
  "battery-charging": "Battery",
  bell: "Bell",
  bookmark: "Star",
  check: "Check",
  "chevron-down": "ChevronDown",
  "chevron-left": "ArrowLeft",
  "chevron-right": "ChevronRight",
  "chevrons-down": "ChevronDown",
  clock: "Clock",
  cloud: "Globe",
  "cloud-off": "Globe",
  copy: "Copy",
  cpu: "Cpu",
  download: "ArrowRight",
  "download-cloud": "ArrowRight",
  "edit-2": "Pencil",
  "edit-3": "Pencil",
  "file-text": "FileEdit",
  folder: "Folder",
  "folder-plus": "Folder",
  grid: "MoreHoriz",
  heart: "Star",
  home: "Home",
  image: "Camera",
  info: "AlertCircle",
  layers: "MoreHoriz",
  maximize: "MoreHoriz",
  menu: "MoreHoriz",
  "message-circle": "Send",
  "more-vertical": "MoreVert",
  paperclip: "Paperclip",
  play: "Play",
  plus: "Plus",
  "rotate-ccw": "Reset",
  search: "Search",
  settings: "Settings",
  share: "Share",
  shield: "Lock",
  smartphone: "Phone",
  star: "Star",
  "trash-2": "Trash",
  "upload-cloud": "Globe",
  user: "User",
  "user-plus": "User",
  users: "Users",
  x: "X",
  "x-circle": "X",
  zap: "Bolt",
  "zap-off": "Bolt",
};

export function resolveIconName(name: string): IconName {
  if (isIconName(name)) return name;
  return ALIASES[name] ?? "MoreHoriz";
}

export interface IconProps {
  name: IconName | string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Icon({
  name,
  size = 20,
  color = "#141820",
  strokeWidth = 1.5,
}: IconProps): React.JSX.Element | null {
  const paths = icons[resolveIconName(name)];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {paths.map((p, i) => (
        <Path
          key={i}
          d={p.d}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={p.fill === "currentColor" ? color : "none"}
        />
      ))}
    </Svg>
  );
}
