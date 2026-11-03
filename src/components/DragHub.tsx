"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

/**
 * One drag-and-drop context for the board and the "Need to action" backlog, so
 * a row can be carried from one to the other (the user's ask, 2026-10-01).
 *
 * dnd-kit only lets a draggable reach droppables inside its own DndContext,
 * and each list used to have its own. Each list now registers its handlers
 * here as an "area"; every event goes to every area and each one acts only on
 * what concerns it — its own rows moving, a foreign row landing on it, or one
 * of its rows leaving for the other list.
 *
 * Ids keep the two apart: backlog rows are `action:<id>` and the backlog's
 * drop zone is BACKLOG_ZONE; everything else is the board's (day columns are
 * their ymd, rows their item key, none of which start with `action:`).
 */

export const BACKLOG_ZONE = "need-to-action";
export const ACTION_ID_PREFIX = "action:";

/** True for the backlog's drop zone and its rows. */
export function isBacklogId(id: string): boolean {
  return id === BACKLOG_ZONE || id.startsWith(ACTION_ID_PREFIX);
}

export type DragArea = {
  onDragStart?: (event: DragStartEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void | Promise<void>;
  onDragCancel?: () => void;
  /** What the pointer carries while `activeId` is dragged — null when it is not this area's. */
  overlay?: (activeId: string) => React.ReactNode | null;
};

type Register = (name: string, area: { current: DragArea }) => () => void;

const HubContext = createContext<Register | null>(null);

/**
 * Join the shared context. The handlers are read through a ref at event time,
 * so an area's latest render is always the one that answers.
 */
export function useDragArea(name: string, area: DragArea): void {
  const register = useContext(HubContext);
  const ref = useRef(area);
  ref.current = area;
  useEffect(() => register?.(name, ref), [register, name]);
}

/**
 * Which droppables are in play. The pointer being inside the backlog's zone
 * decides the side: there, the closest backlog row (closestCenter, as the list
 * always used); anywhere else, the board's own rule (closestCorners) over
 * board droppables only. Without the split, a drag along the board's first
 * column would snap to the sidebar next to it, and a backlog reorder could
 * pick the zone itself over the row under the pointer.
 */
const collision: CollisionDetection = (args) => {
  const zone = args.droppableContainers.filter((c) => c.id === BACKLOG_ZONE);
  const inBacklog = zone.length > 0 && pointerWithin({ ...args, droppableContainers: zone }).length > 0;
  if (inBacklog) {
    const rows = args.droppableContainers.filter((c) => String(c.id).startsWith(ACTION_ID_PREFIX));
    return closestCenter({ ...args, droppableContainers: rows.length ? rows : zone });
  }
  const board = args.droppableContainers.filter((c) => !isBacklogId(String(c.id)));
  return closestCorners({ ...args, droppableContainers: board });
};

export default function DragHub({ children }: { children: React.ReactNode }) {
  const areas = useRef(new Map<string, { current: DragArea }>());
  const [activeId, setActiveId] = useState<string | null>(null);

  const register = useCallback<Register>((name, area) => {
    areas.current.set(name, area);
    return () => {
      if (areas.current.get(name) === area) areas.current.delete(name);
    };
  }, []);

  const each = (fn: (area: DragArea) => void) => {
    for (const area of areas.current.values()) fn(area.current);
  };

  const sensors = useSensors(
    // A small threshold keeps checkbox and title clicks working; a drag only
    // starts once the pointer actually travels.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  let overlay: React.ReactNode = null;
  if (activeId) {
    for (const area of areas.current.values()) {
      overlay = area.current.overlay?.(activeId) ?? null;
      if (overlay) break;
    }
  }

  return (
    <HubContext.Provider value={register}>
      <DndContext
        // Explicit id: dnd-kit otherwise numbers its aria-describedby target
        // from a module-level counter, which server and client can disagree on
        // once there is more than one DndContext on the page — a hydration
        // mismatch.
        id="board"
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={(event) => {
          setActiveId(String(event.active.id));
          each((a) => a.onDragStart?.(event));
        }}
        onDragOver={(event) => each((a) => a.onDragOver?.(event))}
        onDragEnd={(event) => {
          setActiveId(null);
          each((a) => void a.onDragEnd?.(event));
        }}
        onDragCancel={() => {
          setActiveId(null);
          each((a) => a.onDragCancel?.());
        }}
        // Only a pointer can drag here, so don't let dnd-kit tell a screen
        // reader otherwise: Space on a row opens the rename editor, which is
        // the real keyboard affordance.
        accessibility={{ screenReaderInstructions: { draggable: "" } }}
      >
        {children}
        {/* One overlay for both lists. The backlog sits in the sidebar's
            scroll box, which clips a row dragged out of it; the overlay is
            drawn above everything, so the row stays under the pointer all the
            way to the board. */}
        <DragOverlay dropAnimation={null}>{overlay}</DragOverlay>
      </DndContext>
    </HubContext.Provider>
  );
}
