/**
 * Reading a drop as "between these two", rather than as a position in a list.
 *
 * The tab that started the drag can be a refetch behind — something synced in,
 * something was ticked off on the phone — and an index counted against its copy
 * of the list points at a different row by the time the server reads it. The
 * keys either side of the gap survive that; they either still exist or they
 * plainly do not.
 *
 * Shared by the board and the "Need to action" backlog, so it lives on its own
 * rather than in either one's module.
 */

/**
 * Where an item dropped between `beforeKey` and `afterKey` belongs in `keys`
 * (which must not contain the item being placed).
 *
 * Null when both named neighbours have gone: the gap the user aimed at no
 * longer exists, and any index would be a guess.
 */
export function indexForNeighbours(
  keys: string[],
  beforeKey: string | null,
  afterKey: string | null,
): number | null {
  if (beforeKey !== null) {
    const at = keys.indexOf(beforeKey);
    if (at !== -1) return at + 1;
  }
  if (afterKey !== null) {
    const at = keys.indexOf(afterKey);
    if (at !== -1) return at;
  }
  if (beforeKey === null) return 0;
  if (afterKey === null) return keys.length;
  return null;
}
