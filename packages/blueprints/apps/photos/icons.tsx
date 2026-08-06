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

// The selection bar's five actions (v4 handoff §6, CHANGELOG B2) — the new
// lowercase icon keys, not the pre-existing capitalised ones above. B2 is
// explicit that these entries "share their exact artwork rather than drawing
// a second, competing glyph for the same action", so Favorite/Trash here are
// deliberately a second export, not a reuse of HeartIcon/TrashIcon.
export const SelectFavoriteIcon = make("heart");
export const SelectAlbumIcon = make("album");
export const SelectShareIcon = make("share");
export const SelectRemoveFromIcon = make("removeFrom");
export const SelectDownloadIcon = make("download");
export const SelectTrashIcon = make("trash");
export const SelectRestoreIcon = make("restore");
// The viewer's two marks that had no honest stand-in (CHANGELOG §B2).
//
// `more` is bound to the registry's own key rather than re-using `Menu`: the
// two are different actions to the member — `Menu` opens navigation, `more`
// opens the rest of THIS bar — and "an action that changes its icon between
// surfaces is a different action".
//
// `info` replaces `AlertCircle` on the stage for the same reason in reverse:
// an alert glyph on an Info control says something went wrong, which is a
// different message from "here is what is known about this photograph".
export const MoreIcon = make("more");
export const InfoMarkIcon = make("info");
