/**
 * The rule for saving a title typed into the details panel.
 *
 * A title is one line. It is a textarea only so a long meeting sentence can
 * wrap, so a line break typed or pasted into it becomes a space.
 *
 * An empty title puts the old one back rather than deleting the item, as the
 * row's editor does. Deleting a goal task deletes its note, and the usual way
 * to retype a title is ⌘A, Delete, type: a blur in between (clicking into the
 * notes to copy a phrase) would take the task and its whole checklist with no
 * undo. The row can afford delete-on-empty because it holds nothing but the
 * title.
 *
 * Pure, no imports — the client imports this directly, like lib/checklist.
 */

/** A title is one line: line breaks become a space, then trimmed. */
export function normaliseTitle(raw: string): string {
  return raw.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export type TitleCommit =
  | { action: "none" }
  | { action: "revert" }
  | { action: "save"; title: string };

/**
 * What to do with a draft when the field loses focus or the panel closes.
 * `current` is what the server will hold once queued renames land, not the
 * last title it confirmed — otherwise the Close button's blur and its close
 * would each send the same rename.
 */
export function titleCommit(draft: string, current: string): TitleCommit {
  const title = normaliseTitle(draft);
  if (!title) return { action: "revert" };
  if (title === current) return { action: "none" };
  return { action: "save", title };
}
