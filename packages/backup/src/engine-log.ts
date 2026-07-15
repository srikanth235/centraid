/** Minimal logger seam shared by the engine and the WAL replay path. */
export interface EngineLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}
