export type DocRowAction = "open" | "edit" | "copyId" | "delete";

export interface DocRowActionLabels {
  open: string;
  edit?: string;
  copyId: string;
  delete?: string;
}

export interface DocRowMenuItem {
  action: DocRowAction;
  label: string;
}

export interface DocRowMenu {
  record: readonly DocRowMenuItem[];
  danger: readonly DocRowMenuItem[];
}

export function docRowMenu(labels: DocRowActionLabels): DocRowMenu {
  const record: DocRowMenuItem[] = [{ action: "open", label: labels.open }];
  if (labels.edit) record.push({ action: "edit", label: labels.edit });
  record.push({ action: "copyId", label: labels.copyId });
  return {
    danger: labels.delete ? [{ action: "delete", label: labels.delete }] : [],
    record,
  };
}

export function docSnipLine(kind: string, written: string): string {
  return [kind, written].filter(Boolean).join(" · ");
}
