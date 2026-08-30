// Photos registering itself as the frame's camera-roll target (#883 C6).
//
// A MODULE SIDE EFFECT, and deliberately so: the whole point of the frame
// watcher is that backup runs when no Photos screen is mounted, so the
// registration cannot live in a component. The frame imports this file once at
// boot — the same shape as `configurePhotoImageCache`, which App.tsx already
// pulls from this app for the same reason.
//
// Nothing else belongs here. The frame owns the triggers; Photos owns what a
// sweep DOES; this file is the one line that joins them.

import { registerCameraRollSweep } from "../../lib/camera-roll/watcher";
import { sweepCameraRollBackup } from "./photos-backup";

registerCameraRollSweep(sweepCameraRollBackup);
