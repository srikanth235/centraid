export interface EngineLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}
