/**
 * The slide-out navigation drawer.
 *
 * This app has no router: navigation is a panel name handed to the workspace,
 * which opens the matching sheet over the drawing. The sidebar follows that
 * convention rather than introducing a second one — every item here either
 * resolves to a panel the app already has, or is marked as somewhere it cannot
 * take you yet.
 *
 * That marking is deliberate. Half of the sections a full product would carry —
 * a profile, saved items, reports, documents, settings, help, and signing out —
 * do not exist in this app, and several have nothing behind them to build on
 * (there is no account system at all, so there is nothing to log out of). An
 * item that silently does nothing when tapped is worse than one that says it is
 * not ready, because the first reads as a bug and the second reads as a plan.
 *
 * Motion, scrim, tokens and controls are the ones the bottom sheets already
 * use, so the drawer is the same object family rather than a second design.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { usePresence } from './motion.js';
import './sidebar.css';

/**
 * Where a sidebar item goes.
 *
 * `panel` names a sheet the workspace already knows how to open. `canvas`
 * means the drawing itself, which in a sheet-over-canvas app is reached by
 * dismissing whatever is covering it. `unavailable` is a destination this app
 * does not have.
 */
export type SidebarTarget =
  | { readonly kind: 'panel'; readonly panel: SidebarPanel }
  | { readonly kind: 'canvas' }
  | { readonly kind: 'unavailable' };

/** The panels the sidebar can reach. A subset of the workspace's own union. */
export type SidebarPanel = 'ai' | 'projects' | 'tools';

export interface SidebarItem {
  readonly id: string;
  readonly label: string;
  /** A glyph, matching the tab bar's convention — this app ships no icon font. */
  readonly glyph: string;
  readonly target: SidebarTarget;
  /** Shown under the label on items that lead somewhere that does not exist. */
  readonly note?: string;
}

/**
 * The primary sections, then the secondary ones.
 *
 * Kept as data rather than markup so the two groups render identically and
 * cannot drift apart, and so the set can be read at a glance.
 */
export const SIDEBAR_PRIMARY: readonly SidebarItem[] = [
  { id: 'ai', label: 'AI', glyph: '✦', target: { kind: 'panel', panel: 'ai' } },
  { id: 'projects', label: 'Projects', glyph: '▤', target: { kind: 'panel', panel: 'projects' } },
  { id: 'drawings', label: 'Drawings', glyph: '◳', target: { kind: 'canvas' } },
  { id: 'tools', label: 'Tools', glyph: '⚒', target: { kind: 'panel', panel: 'tools' } },
  { id: 'profile', label: 'Profile', glyph: '☺', target: { kind: 'unavailable' }, note: 'No accounts yet' },
];

export const SIDEBAR_SECONDARY: readonly SidebarItem[] = [
  { id: 'saved', label: 'Saved', glyph: '★', target: { kind: 'unavailable' }, note: 'Not built yet' },
  { id: 'reports', label: 'Reports', glyph: '❋', target: { kind: 'unavailable' }, note: 'Not built yet' },
  { id: 'documents', label: 'Documents', glyph: '❐', target: { kind: 'unavailable' }, note: 'Not built yet' },
  { id: 'settings', label: 'Settings', glyph: '⚙', target: { kind: 'unavailable' }, note: 'Not built yet' },
  { id: 'help', label: 'Help', glyph: '?', target: { kind: 'unavailable' }, note: 'Not built yet' },
  { id: 'logout', label: 'Logout', glyph: '⇥', target: { kind: 'unavailable' }, note: 'No sign-in to leave' },
];

/** How far left a drag must travel before releasing it closes the drawer. */
const SWIPE_CLOSE_PX = 64;

export function Sidebar({
  open,
  onClose,
  onNavigate,
  activeId,
  subtitle,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onNavigate: (item: SidebarItem) => void;
  /** Which section is showing, so the drawer can mark it. */
  readonly activeId: string | null;
  readonly subtitle?: string;
}) {
  const { mounted, state } = usePresence(open);
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();
  /**
   * Live offset while a finger is dragging the drawer leftwards.
   *
   * Held in a ref as well as in state. The state drives the transform; the ref
   * is what `pointerup` reads, because a pointer sequence can complete inside
   * one task with no re-render between the moves and the release, and the
   * handler's closure would still be holding the offset from the last paint —
   * which is zero, so every swipe would look like no swipe at all.
   */
  const [dragX, setDragX] = useState(0);
  const dragOffset = useRef(0);
  const drag = useRef<{ startX: number; startY: number; tracking: boolean } | null>(null);

  const setOffset = (next: number): void => {
    dragOffset.current = next;
    setDragX(next);
  };

  // Escape closes, as it does for every sheet in the app.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /**
   * Hold the page still while the drawer is over it.
   *
   * The workspace does not scroll, but a short viewport or a zoomed-in browser
   * can still move the document behind a fixed overlay, and a drawer that
   * scrolls the plan out from under itself feels broken.
   */
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Focus moves into the drawer when it opens, so the keyboard follows it.
  useEffect(() => {
    if (state === 'open') panelRef.current?.focus();
  }, [state]);

  useEffect(() => {
    if (!open) {
      dragOffset.current = 0;
      setDragX(0);
    }
  }, [open]);

  /**
   * Keep Tab inside the drawer while it is open.
   *
   * It covers the app and takes the pointer, so letting focus walk out into
   * the drawing behind it would leave a keyboard user typing at something they
   * cannot see.
   */
  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const host = panelRef.current;
    if (!host) return;

    const focusable = [...host.querySelectorAll<HTMLElement>('button:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!mounted) return null;

  return (
    <div className={`drawer drawer--${state}`}>
      {/*
        The scrim is a convenience rather than the accessible way out — Escape
        and the close button are both real controls — so it is hidden from the
        accessibility tree instead of appearing there as a second "Close".
      */}
      <div className="drawer__scrim" aria-hidden="true" onClick={onClose} />

      <nav
        ref={panelRef}
        className="drawer__panel"
        style={dragX < 0 ? { transform: `translateX(${dragX}px)`, transition: 'none' } : undefined}
        aria-label="Sections"
        aria-modal="true"
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          // Mouse drags are not a gesture anyone expects here, and would fight
          // with clicking an item.
          if (event.pointerType !== 'touch') return;
          drag.current = { startX: event.clientX, startY: event.clientY, tracking: false };
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          if (!from) return;

          const dx = event.clientX - from.startX;
          const dy = event.clientY - from.startY;

          // Decide once whether this is a horizontal swipe or a vertical
          // scroll, so a flick down the list never drags the drawer sideways.
          if (!from.tracking) {
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
            if (Math.abs(dy) > Math.abs(dx)) {
              drag.current = null;
              return;
            }
            from.tracking = true;
          }

          // Leftwards only: the drawer is already against the left edge, so
          // pulling it right has nowhere to go.
          setOffset(Math.min(0, dx));
        }}
        onPointerUp={() => {
          const travelled = dragOffset.current;
          drag.current = null;
          setOffset(0);
          if (travelled <= -SWIPE_CLOSE_PX) onClose();
        }}
        onPointerCancel={() => {
          drag.current = null;
          setOffset(0);
        }}
      >
        <header className="drawer__header">
          <div className="drawer__identity">
            <h2 id={titleId} className="drawer__title">
              Surveyor
            </h2>
            {subtitle ? <p className="drawer__subtitle">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="drawer__close"
            aria-label="Close menu"
            title="Close menu"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="drawer__scroll">
          <ul className="drawer__list">
            {SIDEBAR_PRIMARY.map((item) => (
              <SidebarRow
                key={item.id}
                item={item}
                active={item.id === activeId}
                onNavigate={onNavigate}
              />
            ))}
          </ul>

          {/* The secondary group is separated by a rule and a heading rather
              than by being quieter, so it reads as another section and not as
              a set of disabled controls. */}
          <p className="drawer__group">More</p>
          <ul className="drawer__list">
            {SIDEBAR_SECONDARY.map((item) => (
              <SidebarRow
                key={item.id}
                item={item}
                active={item.id === activeId}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </div>
      </nav>
    </div>
  );
}

function SidebarRow({
  item,
  active,
  onNavigate,
}: {
  readonly item: SidebarItem;
  readonly active: boolean;
  readonly onNavigate: (item: SidebarItem) => void;
}) {
  const unavailable = item.target.kind === 'unavailable';

  return (
    <li>
      <button
        type="button"
        className={`drawer__item${active ? ' is-active' : ''}${unavailable ? ' is-unavailable' : ''}`}
        // Disabled rather than silently inert: a control that looks live and
        // does nothing is read as a fault. `aria-disabled` keeps it reachable
        // by keyboard so the section is still announced.
        aria-disabled={unavailable || undefined}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          if (unavailable) return;
          onNavigate(item);
        }}
      >
        <span className="drawer__glyph" aria-hidden="true">
          {item.glyph}
        </span>
        <span className="drawer__label">{item.label}</span>
        {item.note ? <span className="drawer__note">{item.note}</span> : null}
      </button>
    </li>
  );
}
