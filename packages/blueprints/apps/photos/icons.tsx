// Photos uses the same registry as the other blueprint apps.  The small
// component adapter preserves the existing exports and lets CSS continue to
// provide currentColor without embedding a second SVG dictionary here.
import type { FC, ReactElement, SVGProps } from "react";

import { iconSvg } from "@centraid/design";
import type { IconName } from "@centraid/design";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function RegisteredIcon({
  name,
  filled,
  ...props
}: IconProps & { name: IconName; filled?: boolean }) {
  const { size = 18, strokeWidth = 1.75, color, className, style } = props;
  const markup = filled
    ? iconSvg(name, { size, strokeWidth: Number(strokeWidth) }).replace(
        'fill="none"',
        'fill="currentColor"'
      )
    : iconSvg(name, { size, strokeWidth: Number(strokeWidth) });
  return (
    <i
      aria-hidden="true"
      className={className}
      style={{ ...style, color }}
      // oxlint-disable-next-line react/no-danger -- registry output is the reviewed shared icon lowering.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

const make = (name: IconName): FC<IconProps> => {
  function Icon(props: IconProps) {
    return <RegisteredIcon {...props} name={name} />;
  }
  return Icon;
};

export const CameraIcon = make("Camera");
export const GridIcon = make("Image");
export function HeartIcon(
  props: IconProps & { filled?: boolean }
): ReactElement {
  return <RegisteredIcon {...props} name="Heart" filled={props.filled} />;
}
export const AlbumsIcon = make("Folder");
export const DuplicatesIcon = make("Copy");
export const TrashIcon = make("Trash");
export const CloseIcon = make("X");
export const MenuIcon = make("Menu");
export const SearchIcon = make("Search");
export const ZoomOutIcon = make("Grid");
export const ZoomInIcon = make("Grid");
// Face detection is "find the PEOPLE in this photo", and it must not be a
// second sparkle: the kit's Ask control (`kit-ask-btn`) renders a ✦ + "Ask"
// immediately beside it in the same header, so two adjacent sparkles read as
// one action spelled twice (#708).
export const FacesIcon = make("Users");
export const InfoIcon = make("AlertCircle");
export const DownloadIcon = make("Download");
export const ShareIcon = make("Share");
export const EditIcon = make("Pencil");
export const PlayIcon = make("Play");
export const PauseIcon = make("Pause");
export const ChevronLeftIcon = make("ChevronLeft");
export const ChevronRightIcon = make("ChevronRight");
export const CheckIcon = make("Check");
export const PlusIcon = make("Plus");
export const ShieldIcon = make("CheckCircle");
export const PinIcon = make("Pin");
export const RenameIcon = make("Pencil");
