import { addDays, monthGridDays, weekDays } from "./time.js";
import { listPauses, type PauseRecord } from "./pauses.js";
import {
  getHabitProgress,
  getOccurrences,
  listActions,
  listCalendars,
  listHabits,
  listTasks,
  type ActionRecord,
  type TaskRecord,
} from "./store.js";
import { syncStatus } from "./sync.js";
import { buildBoardItems, type BoardItem } from "./board.js";
import type { CalendarRecord, HabitProgress, Occurrence, SyncStatus } from "./types.js";

export type ViewMode = "month" | "week";

/**
 * The to-do board is a rolling window of three seven-day rows anchored on
 * today: the week just gone, the week starting today, and the week after.
 * Rows follow today rather than the Monday–Sunday convention used everywhere
 * else, so the middle row always opens on today and nothing recent scrolls out
 * of reach.
 */
export const BOARD_ROW_DAYS = 7;
export const BOARD_ROWS = 3;

/** Days before today, i.e. how far the first row reaches back. */
const BOARD_LOOKBACK = BOARD_ROW_DAYS;

export function boardDays(today: string): string[] {
  const start = addDays(today, -BOARD_LOOKBACK);
  return Array.from({ length: BOARD_ROW_DAYS * BOARD_ROWS }, (_, i) => addDays(start, i));
}

export type BoardState = {
  days: string[];
  occurrences: Occurrence[];
  tasks: TaskRecord[];
  /** Events and to-dos merged into one hand-orderable list per day. */
  items: Record<string, BoardItem[]>;
};

export type CalendarState = {
  view: ViewMode;
  anchor: string;
  days: string[];
  occurrences: Occurrence[];
  progress: HabitProgress[];
  calendars: CalendarRecord[];
  habits: ReturnType<typeof listHabits>;
  sync: SyncStatus[];
  today: string;
  board: BoardState;
  /** Undated backlog shown in the sidebar on the dashboard. */
  actions: ActionRecord[];
  /** Time away, including pending proposals from the inbox (flagged). */
  pauses: PauseRecord[];
};

export function rangeFor(view: ViewMode, anchor: string): string[] {
  return view === "week" ? weekDays(anchor) : monthGridDays(anchor);
}

function buildBoard(today: string): BoardState {
  const days = boardDays(today);
  const occurrences = getOccurrences(days[0], days[days.length - 1]);
  const tasks = listTasks(days[0], days[days.length - 1]);
  return {
    days,
    occurrences,
    tasks,
    items: buildBoardItems(days, occurrences, tasks),
  };
}

export function buildState(view: ViewMode, anchor: string, today: string): CalendarState {
  const days = rangeFor(view, anchor);
  return {
    view,
    anchor,
    days,
    occurrences: getOccurrences(days[0], days[days.length - 1]),
    progress: getHabitProgress(today),
    calendars: listCalendars(),
    habits: listHabits(),
    sync: syncStatus(),
    today,
    board: buildBoard(today),
    actions: listActions(),
    pauses: listPauses(),
  };
}
