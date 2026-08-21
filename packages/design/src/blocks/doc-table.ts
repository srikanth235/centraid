// The record table's two pieces of logic (#765, spec §9/§11): the snip line
// that replaces the fixed columns when they are hidden, and the row menu's
// shape.
//
// Both renderers hide the `Kind` and `Written` columns on the compact form
// factor — one is always compact, the other becomes so — and both replace them
// with the same one line under the title. And both offer the same row verbs in
// the same order, with the destructive one held apart. Neither fact is about
// DOM or about React Native, so neither is written twice.

/** What a row menu can do to a record. */
export type DocRowAction = "open" | "edit" | "copyId" | "delete";

/**
 * The menu's words. There are no defaults: a block that shipped its own copy
 * would be the one place in the product where a string has no author.
 *
 * `edit` and `delete` are OPTIONAL because not every surface can perform them
 * — a menu that listed a verb the caller cannot honour would be lying, and a
 * two-item menu is a truthful menu.
 */
export interface DocRowActionLabels {
  open: string;
  edit?: string;
  copyId: string;
  /** Drawn destructive, and separated from the rest. */
  delete?: string;
}

/** One item, resolved. */
export interface DocRowMenuItem {
  action: DocRowAction;
  label: string;
}

/**
 * The menu, in two groups.
 *
 * `danger` is its own group so that whatever draws it puts a rule above the
 * destructive verb: a delete never sits one thumb-width from "Copy the id".
 * Either group may be empty, and a renderer draws only the groups that are.
 */
export interface DocRowMenu {
  record: readonly DocRowMenuItem[];
  danger: readonly DocRowMenuItem[];
}

/** The menu for one record, in the reference's order, minus whatever the
 *  caller did not name. */
export function docRowMenu(labels: DocRowActionLabels): DocRowMenu {
  const record: DocRowMenuItem[] = [{ action: "open", label: labels.open }];
  if (labels.edit) record.push({ action: "edit", label: labels.edit });
  record.push({ action: "copyId", label: labels.copyId });
  return {
    danger: labels.delete ? [{ action: "delete", label: labels.delete }] : [],
    record,
  };
}

/**
 * The snip line — the two hidden columns, joined.
 *
 * `kind · written`. Either half may be missing (a store that does not report a
 * kind is not a reason to render a stray separator), and if both are, there is
 * no second line at all and the row is a title on its own.
 */
export function docSnipLine(kind: string, written: string): string {
  return [kind, written].filter(Boolean).join(" · ");
}
