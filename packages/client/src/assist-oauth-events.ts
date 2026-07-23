export const ASSIST_HANDOFF_EVENT = 'centraid:assist-oauth-handoff';

export type AssistHandoffResult =
  | { status: 'none' }
  | { status: 'complete'; connectionId: string }
  | { status: 'error'; message: string };
