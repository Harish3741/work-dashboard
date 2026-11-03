import type { CalendarRecord } from "../types.js";

/** One expanded occurrence, already normalised to APP_TZ wall-clock. */
export type ParsedOccurrence = {
  uid: string;
  recurrenceId: string | null;
  title: string;
  ymd: string;
  startMin: number | null;
  endYmd: string;
  endMin: number | null;
  allDay: boolean;
  notes: string | null;
  /**
   * The video call this event happens on (Google's X-GOOGLE-CONFERENCE, or a
   * meet / zoom / teams link in LOCATION, DESCRIPTION or URL). Optional so a
   * source that cannot tell (CalDAV) leaves it out; read by meeting notes.
   */
  conferenceUrl?: string | null;
  /** ATTENDEE lines: CN and mailto. Empty or absent when the feed has none. */
  attendees?: { name: string | null; email: string | null }[];
};

export type FetchWindow = { fromYmd: string; toYmd: string };

/** What a source reports about the calendar itself, alongside its events. */
export type ParsedCalendarMeta = {
  /** "#rrggbb" as published by the provider, or null if it does not say. */
  color: string | null;
};

/**
 * Where calendar data comes from. Today the only implementation is the
 * published-ICS one; a CalDAV implementation slots in here without the sync
 * layer, the store, or the UI changing.
 */
export interface CalendarSource {
  readonly kind: string;
  fetchOccurrences(calendar: CalendarRecord, window: FetchWindow): Promise<ParsedOccurrence[]>;
  /**
   * The calendar's own presentation metadata, captured during the same fetch
   * so matching the provider's colour costs no extra request.
   */
  fetchMeta?(calendar: CalendarRecord): ParsedCalendarMeta | null;
}
