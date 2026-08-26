export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface AppInfo {
  id: string;
  dir: string;
  built: boolean;
  modifiedAt: string;
  name?: string;
  description?: string;
  /** Legacy `auto.` id prefix superseded ('automation' = UI-less). */
  kind?: "app" | "automation";
}

export type AppScaffoldErrorCode =
  | "no_app"
  | "not_found"
  | "conflict"
  | "invalid_id"
  | "invalid_manifest"
  | "already_exists";

export class AppScaffoldError extends Error {
  constructor(
    public readonly code: AppScaffoldErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AppScaffoldError";
  }
}
