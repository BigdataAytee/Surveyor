/**
 * Animation primitives (Architecture B.16).
 *
 * A small set of reusable transitions rather than ad-hoc CSS per component, so
 * timing stays consistent across the app. Every one of these degrades to an
 * instant appearance under prefers-reduced-motion, which the token file
 * handles by collapsing the duration variables — no component needs to know.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import './motion.css';

type Variant = 'fade' | 'slide-up' | 'scale' | 'spring';

interface EnterProps {
  readonly children: ReactNode;
  /** Stagger, in milliseconds, for lists that should cascade in. */
  readonly delay?: number;
  readonly className?: string;
}

function Enter({
  variant,
  children,
  delay = 0,
  className = '',
}: EnterProps & { variant: Variant }) {
  return (
    <div
      className={`enter enter--${variant} ${className}`}
      style={delay > 0 ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

export const FadeIn = (props: EnterProps) => <Enter variant="fade" {...props} />;
export const SlideUp = (props: EnterProps) => <Enter variant="slide-up" {...props} />;
export const ScaleIn = (props: EnterProps) => <Enter variant="scale" {...props} />;
export const SpringIn = (props: EnterProps) => <Enter variant="spring" {...props} />;

/**
 * Keeps a component mounted while it animates out.
 *
 * Sheets and dialogs need their exit animation to finish before they leave the
 * tree, which React does not give you for free.
 */
export function usePresence(open: boolean, durationMs = 280): {
  readonly mounted: boolean;
  readonly state: 'entering' | 'open' | 'leaving' | 'closed';
} {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<'entering' | 'open' | 'leaving' | 'closed'>(
    open ? 'open' : 'closed',
  );
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);

    if (open) {
      setMounted(true);
      setState('entering');
      timer.current = window.setTimeout(() => setState('open'), 20);
    } else if (mounted) {
      setState('leaving');
      timer.current = window.setTimeout(() => {
        setMounted(false);
        setState('closed');
      }, durationMs);
    }

    return () => window.clearTimeout(timer.current);
  }, [open, durationMs, mounted]);

  return { mounted, state };
}

/**
 * Runs a callback when a value changes, used to pulse an object on the canvas
 * when the assistant mentions it (B.13).
 */
export function useHighlightPulse(subjectId: string | null): boolean {
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (!subjectId) return undefined;
    setPulsing(true);
    const timer = window.setTimeout(() => setPulsing(false), 1400);
    return () => window.clearTimeout(timer);
  }, [subjectId]);

  return pulsing;
}

/** True when the user has asked the system to minimise motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  return reduced;
}
