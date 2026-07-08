import { Toast } from '@centraid/blueprint-kit-ds';

export function Saved() {
  return <Toast text="Note saved to your vault" />;
}

export function WithUndo() {
  return <Toast text="Moved “Q3 planning” to Trash" undoLabel="Undo" tone="accent" />;
}

export function Danger() {
  return <Toast text="Couldn’t reach the vault — retrying when you’re back" tone="danger" />;
}
