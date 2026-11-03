/**
 * Who is in a calendar event, and which video call it happens on.
 *
 * Pure and dependency-free, so the ICS parser, the meeting-notes upcoming
 * list and their tests all read events the same way. Kept for one reader: the
 * meeting-notes recorder asks `/api/meeting-notes/upcoming` which meetings
 * have a call link, so it can start on time and title the session.
 */

export type ConferencePlatform = "meet" | "zoom" | "teams";

export type EventAttendee = { name: string | null; email: string | null };

/**
 * A call link inside free text (LOCATION, DESCRIPTION, URL). Google's own
 * description is HTML (`<a href="https://meet.google.com/…">`), so a link
 * stops at a quote, an angle bracket or whitespace.
 *
 * Zoom: `/j/`, `/my/`, `/w/` and the web client's `/wc/`, on zoom.us and
 * zoomgov.com (and their `us02web.`-style subdomains). Teams: the classic
 * `/l/meetup-join/`, the newer `/meet/<id>?p=<passcode>` that new Teams
 * invites carry (on teams.microsoft.com and teams.cloud.microsoft), and
 * teams.live.com's consumer `/meet/`.
 */
const LINK_TAIL = String.raw`[^\s<>"'()[\]{}\\]+`;
const CALL_LINK = new RegExp(
  String.raw`https?:\/\/(?:` +
    String.raw`meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}` +
    String.raw`|(?:[\w-]+\.)?zoom(?:gov\.com|\.us)\/(?:j|my|w|wc)\/` + LINK_TAIL +
    String.raw`|teams\.(?:microsoft\.com|cloud\.microsoft)\/(?:l\/meetup-join|meet)\/` + LINK_TAIL +
    String.raw`|teams\.live\.com\/meet\/` + LINK_TAIL +
    `)`,
  "i",
);

/** "meet" | "zoom" | "teams" for a call link, null for anything else. */
export function conferencePlatform(url: string | null | undefined): ConferencePlatform | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "meet.google.com") return "meet";
  if (host === "zoom.us" || host.endsWith(".zoom.us")) return "zoom";
  if (host === "zoomgov.com" || host.endsWith(".zoomgov.com")) return "zoom";
  if (host === "teams.microsoft.com" || host === "teams.cloud.microsoft" || host === "teams.live.com") return "teams";
  return null;
}

/** The first call link in any of these texts, trailing punctuation trimmed. */
export function findCallLink(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (!text) continue;
    const match = text.match(CALL_LINK);
    if (match) return match[0].replace(/[.,;:!?]+$/, "");
  }
  return null;
}

/**
 * The event's conference URL. Google's `X-GOOGLE-CONFERENCE` wins when it is a
 * call we know (it is the event's own Meet link, not a guess); otherwise the
 * first meet / zoom / teams link in LOCATION, DESCRIPTION or URL.
 */
export function conferenceUrlOf(fields: {
  googleConference?: string | null;
  location?: string | null;
  description?: string | null;
  url?: string | null;
}): string | null {
  const google = (fields.googleConference ?? "").trim();
  if (google && conferencePlatform(google)) return google;
  return findCallLink(fields.location, fields.url, fields.description);
}

/** Most attendees one event keeps: a company all-hands is not a meeting to title. */
export const ATTENDEES_MAX = 50;

/**
 * Attendees from ATTENDEE lines: CN as the name (null when it is only the
 * address again, which is what Google writes for anyone without a profile
 * name), mailto as the email. Rooms and resources are not people.
 */
export function readAttendees(
  rows: { value: string | null; cn: string | null; cutype: string | null }[],
): EventAttendee[] {
  const out: EventAttendee[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cutype = (row.cutype ?? "").toUpperCase();
    if (cutype === "RESOURCE" || cutype === "ROOM") continue;
    const raw = (row.value ?? "").trim();
    const email = /^mailto:/i.test(raw) ? raw.slice(7).trim().toLowerCase() || null : raw.includes("@") ? raw.toLowerCase() : null;
    let name = (row.cn ?? "").trim().replace(/^"|"$/g, "") || null;
    if (name && email && name.toLowerCase() === email) name = null;
    if (!name && !email) continue;
    const key = email ?? `name:${name!.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, email });
    if (out.length >= ATTENDEES_MAX) break;
  }
  return out;
}
