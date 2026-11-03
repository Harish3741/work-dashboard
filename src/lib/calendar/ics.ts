import ICAL from "ical.js";
import type { CalendarRecord } from "../types.js";
import { toWallClock } from "../time.js";
import { conferenceUrlOf, readAttendees, type EventAttendee } from "./conference.js";
import type {
  CalendarSource,
  FetchWindow,
  ParsedCalendarMeta,
  ParsedOccurrence,
} from "./source.js";

/**
 * Reads a published iCloud calendar (the webcal/ICS "Public Calendar" link).
 *
 * Read-only by construction: there is no code path here that writes back to
 * iCloud, which is exactly the guarantee we want.
 */

/** Ceiling on occurrences generated from one recurring event, to bound work. */
const MAX_OCCURRENCES_PER_EVENT = 5000;

const FETCH_TIMEOUT_MS = 20_000;

export function normaliseFeedUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("webcal://")) return `https://${trimmed.slice("webcal://".length)}`;
  return trimmed;
}

export async function fetchIcsText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(normaliseFeedUrl(url), {
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
      headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.8" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) {
      throw new Error("Response was not an iCalendar feed (no BEGIN:VCALENDAR)");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Wall-clock for an ICAL.Time, keeping all-day dates floating. */
function wallOf(time: ICAL.Time): { ymd: string; minutes: number | null } {
  if (time.isDate) {
    const ymd = [
      String(time.year).padStart(4, "0"),
      String(time.month).padStart(2, "0"),
      String(time.day).padStart(2, "0"),
    ].join("-");
    return { ymd, minutes: null };
  }
  const wc = toWallClock(time.toJSDate());
  return { ymd: wc.ymd, minutes: wc.minutes };
}

/**
 * An all-day event's DTEND is exclusive in iCalendar (a one-day event on the
 * 15th ends on the 16th). Pull it back so the grid renders the right span.
 */
function inclusiveAllDayEnd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d - 1));
  return [
    String(shifted.getUTCFullYear()).padStart(4, "0"),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Put in front of an invite the feed's owner has not answered yet. */
export const RSVP_PREFIX = "RSVP: ";

/**
 * Whose calendar this is, when the feed says. Google's private iCal address
 * names the calendar after its owner's address (X-WR-CALNAME:you@gmail.com);
 * iCloud names it "Work", "Life"…, so iCloud feeds come back null and keep
 * their old behaviour untouched.
 */
function feedOwner(root: ICAL.Component): string | null {
  const name = String(root.getFirstPropertyValue("x-wr-calname") ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(name) ? name : null;
}

/** The owner's answer to an invite, e.g. "ACCEPTED", "DECLINED", "NEEDS-ACTION". */
function ownerPartstat(vevent: ICAL.Component, owner: string | null): string | null {
  if (!owner) return null;
  for (const attendee of vevent.getAllProperties("attendee")) {
    const address = String(attendee.getFirstValue() ?? "").replace(/^mailto:/i, "").toLowerCase();
    if (address === owner) return String(attendee.getParameter("partstat") ?? "").toUpperCase() || null;
  }
  return null;
}

/**
 * Google keeps more in a feed than belongs on the board: a cancelled instance
 * of a recurring meeting stays as a STATUS:CANCELLED override, and an invite
 * you declined stays with your PARTSTAT=DECLINED. Both are dropped. An invite
 * you have not answered is kept but titled "RSVP: …" — that is the one most
 * likely to be missed.
 */
function inviteState(vevent: ICAL.Component, owner: string | null): "skip" | "rsvp" | "keep" {
  if (String(vevent.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return "skip";
  const partstat = ownerPartstat(vevent, owner);
  if (partstat === "DECLINED") return "skip";
  if (partstat === "NEEDS-ACTION") return "rsvp";
  return "keep";
}

/** A property's text, or null. */
function propText(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Who is invited and which call it is on, for meeting notes. Read per
 * occurrence component, so a moved or re-linked instance of a recurring
 * meeting carries its own link.
 */
function callDetails(component: ICAL.Component): { conferenceUrl: string | null; attendees: EventAttendee[] } {
  let conferenceUrl: string | null = null;
  let attendees: EventAttendee[] = [];
  try {
    conferenceUrl = conferenceUrlOf({
      googleConference: propText(component, "x-google-conference"),
      location: propText(component, "location"),
      description: propText(component, "description"),
      url: propText(component, "url"),
    });
    attendees = readAttendees(
      component.getAllProperties("attendee").map((p) => ({
        value: p.getFirstValue() === null || p.getFirstValue() === undefined ? null : String(p.getFirstValue()),
        cn: (p.getParameter("cn") as string | undefined) ?? null,
        cutype: (p.getParameter("cutype") as string | undefined) ?? null,
      })),
    );
  } catch {
    // An odd property never costs the event itself.
  }
  return { conferenceUrl, attendees };
}

/**
 * Expand an ICS document into concrete occurrences inside `window`.
 *
 * Handles what a real iCloud feed actually contains: VTIMEZONE definitions,
 * arbitrary RRULEs (not just WEEKLY), EXDATE cancellations, and RECURRENCE-ID
 * overrides where a single instance was moved or renamed. Google feeds add
 * invites and cancelled instances, handled by `inviteState`.
 */
export function parseIcs(icsText: string, window: FetchWindow): ParsedOccurrence[] {
  const root = new ICAL.Component(ICAL.parse(icsText));
  const owner = feedOwner(root);

  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    const tz = new ICAL.Timezone(vtz);
    if (!ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
  }

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];

  for (const vevent of root.getAllSubcomponents("vevent")) {
    let event: ICAL.Event;
    try {
      event = new ICAL.Event(vevent);
    } catch {
      continue; // Malformed VEVENT — skip rather than fail the whole feed.
    }
    if (!event.startDate) continue;
    if (event.isRecurrenceException()) exceptions.push(event);
    else if (event.uid) masters.set(event.uid, event);
  }

  for (const exception of exceptions) {
    const master = exception.uid ? masters.get(exception.uid) : undefined;
    if (master) {
      master.relateException(exception);
    } else if (exception.uid) {
      // Override with no master in the feed — keep it as a standalone event.
      masters.set(`${exception.uid}::${exception.recurrenceId?.toString()}`, exception);
    }
  }

  const out: ParsedOccurrence[] = [];

  for (const event of masters.values()) {
    const uid = event.uid ?? "";
    const summary = (event.summary ?? "").trim() || "(no title)";
    const notes = (event.description ?? "").trim() || null;

    const emit = (
      startTime: ICAL.Time,
      endTime: ICAL.Time | null,
      recurrenceId: string | null,
      title: string,
      description: string | null,
      component: ICAL.Component,
    ) => {
      const state = inviteState(component, owner);
      if (state === "skip") return;
      if (state === "rsvp") title = `${RSVP_PREFIX}${title}`;
      const start = wallOf(startTime);
      if (start.ymd > window.toYmd) return;
      const allDay = startTime.isDate;
      const rawEnd = endTime ? wallOf(endTime) : null;
      const endYmd = rawEnd
        ? allDay
          ? inclusiveAllDayEnd(rawEnd.ymd)
          : rawEnd.ymd
        : start.ymd;
      if ((endYmd < start.ymd ? start.ymd : endYmd) < window.fromYmd) return;
      if (start.ymd < window.fromYmd && endYmd < window.fromYmd) return;

      out.push({
        uid,
        recurrenceId,
        title,
        ymd: start.ymd,
        startMin: allDay ? null : start.minutes,
        endYmd: endYmd < start.ymd ? start.ymd : endYmd,
        endMin: allDay ? null : (rawEnd?.minutes ?? null),
        allDay,
        notes: description,
        ...callDetails(component),
      });
    };

    if (!event.isRecurring()) {
      emit(event.startDate, event.endDate, null, summary, notes, event.component);
      continue;
    }

    let iterator: ICAL.RecurExpansion;
    try {
      iterator = event.iterator();
    } catch {
      emit(event.startDate, event.endDate, null, summary, notes, event.component);
      continue;
    }

    let guard = 0;
    let next: ICAL.Time | null;
    while ((next = iterator.next()) && guard++ < MAX_OCCURRENCES_PER_EVENT) {
      let details;
      try {
        details = event.getOccurrenceDetails(next);
      } catch {
        continue;
      }
      const occStart = wallOf(details.startDate);
      if (occStart.ymd > window.toYmd) break;
      if (occStart.ymd < window.fromYmd) continue;

      // getOccurrenceDetails resolves RECURRENCE-ID overrides, so an instance
      // that was renamed or moved comes back with its edited values.
      emit(
        details.startDate,
        details.endDate,
        details.recurrenceId.toString(),
        (details.item.summary ?? summary).trim() || summary,
        (details.item.description ?? "").trim() || notes,
        details.item.component,
      );
    }
  }

  return out;
}

/**
 * The colour the provider publishes for the calendar itself.
 *
 * Apple writes X-APPLE-CALENDAR-COLOR in the VCALENDAR header, sometimes with
 * an alpha suffix (#rrggbbaa) which is dropped — the app only ever renders it
 * as an opaque swatch.
 */
export function parseCalendarColor(ics: string): string | null {
  const match = ics.match(/^X-APPLE-CALENDAR-COLOR(?:;[^:\r\n]*)?:\s*(#?[0-9A-Fa-f]{6,8})/m);
  if (!match) return null;
  const hex = match[1].startsWith("#") ? match[1] : `#${match[1]}`;
  return hex.slice(0, 7).toLowerCase();
}

export class IcsCalendarSource implements CalendarSource {
  readonly kind = "ics";

  /** Populated by the most recent fetchOccurrences, keyed by calendar id. */
  private meta = new Map<string, ParsedCalendarMeta>();

  async fetchOccurrences(
    calendar: CalendarRecord,
    window: FetchWindow,
  ): Promise<ParsedOccurrence[]> {
    const text = await fetchIcsText(calendar.url);
    this.meta.set(calendar.id, { color: parseCalendarColor(text) });
    return parseIcs(text, window);
  }

  fetchMeta(calendar: CalendarRecord): ParsedCalendarMeta | null {
    return this.meta.get(calendar.id) ?? null;
  }
}
