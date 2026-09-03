import { registerCameraRollSweep } from "../../lib/camera-roll/watcher";
import { sweepCameraRollBackup } from "./photos-backup";

registerCameraRollSweep(sweepCameraRollBackup);
