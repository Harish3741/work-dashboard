"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The four sections, at the right-hand end of every page header — the spot the
 * Streaks and Calendar buttons used to sit in. Each page places it itself: the
 * header is the one row that differs per page, so there is nothing shared to
 * hang it on (`AppShell` owns the sidebar, not the header).
 */

type Section = {
  href: string;
  label: string;
  /** Paths this entry owns. `/` needs an exact match; the rest are prefixes. */
  exact?: boolean;
  icon: React.ReactNode;
  /**
   * Overrides the shared 1.5. The Dashboard mark is four outlined rectangles,
   * and a stroke is centred on its path — so the gaps between them have to be
   * wider than the stroke or the facing edges fuse into one blob at 14px.
   */
  strokeWidth?: number;
};

const SECTIONS: Section[] = [
  {
    href: "/",
    label: "Today",
    exact: true,
    icon: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
  },
  {
    href: "/dashboard",
    label: "Dashboard",
    // A bento grid: short over tall on the left, tall over short on the right.
    // The uneven pairing is the whole point — a uniform 2x2 reads as "apps".
    strokeWidth: 1.2,
    icon: (
      <>
        <rect x="1.5" y="1.5" width="5.6" height="3.92" rx="1.1" />
        <rect x="8.9" y="1.5" width="5.6" height="7.28" rx="1.1" />
        <rect x="1.5" y="7.22" width="5.6" height="7.28" rx="1.1" />
        <rect x="8.9" y="10.58" width="5.6" height="3.92" rx="1.1" />
      </>
    ),
  },
  {
    href: "/streaks",
    label: "Streaks",
    icon: <path d="M2 11l3.5-3.5 3 3L13 5" />,
  },
  {
    href: "/calendar",
    label: "Calendar",
    icon: (
      <>
        <rect x="2" y="3" width="12" height="11" rx="2" />
        <path d="M2 6.5h12M5.5 2v2M10.5 2v2" />
      </>
    ),
  },
];

export default function PageNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Sections" className="flex shrink-0 items-center gap-0.5">
      {SECTIONS.map((section) => {
        const current = section.exact
          ? pathname === section.href
          : pathname.startsWith(section.href);

        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={current ? "page" : undefined}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px]
              transition-colors ${
                current
                  ? "bg-[var(--card)] text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:bg-white/[0.06] hover:text-[var(--text)]"
              }`}
          >
            <svg
              viewBox="0 0 16 16"
              className="size-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={section.strokeWidth ?? 1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {section.icon}
            </svg>
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
