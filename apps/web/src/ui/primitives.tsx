/**
 * Reusable UI primitives (Architecture B.17).
 *
 * Built before any screen, per B.18. Nothing here knows about surveys — these
 * are the buttons, sheets, badges and states the workspace is assembled from.
 */

import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

import { usePresence } from './motion.js';
import './primitives.css';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'suggested';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly full?: boolean;
  readonly icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  full = false,
  icon,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--${size} ${full ? 'btn--full' : ''} ${className}`}
      {...rest}
    >
      {icon ? <span className="btn__icon">{icon}</span> : null}
      {children ? <span className="btn__label">{children}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type StatusTone = 'ready' | 'review' | 'error' | 'neutral' | 'suggested';

const STATUS_GLYPH: Record<StatusTone, string> = {
  ready: '✓',
  review: '⚠',
  error: '✕',
  neutral: '•',
  suggested: '✦',
};

export function StatusBadge({
  tone,
  children,
  onClick,
}: {
  readonly tone: StatusTone;
  readonly children: ReactNode;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      {/*
        The glyph carries the state as well as the colour, so status is never
        conveyed by colour alone (B.16 / accessibility).
      */}
      <span aria-hidden="true" className="badge__glyph">
        {STATUS_GLYPH[tone]}
      </span>
      <span>{children}</span>
    </>
  );

  return onClick ? (
    <button type="button" className={`badge badge--${tone} badge--action`} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span className={`badge badge--${tone}`}>{content}</span>
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

export function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'auto',
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'auto' | 'tall' | 'full';
}) {
  const { mounted, state } = usePresence(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (state === 'open') panelRef.current?.focus();
  }, [state]);

  if (!mounted) return null;

  return (
    <div className={`sheet sheet--${state}`}>
      {/*
        The scrim is a convenience, not the accessible way out: Escape and the
        ✕ button both close the sheet, so exposing it as a second control named
        "Close" would only add a duplicate to the accessibility tree.
      */}
      <div className="sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className={`sheet__panel sheet__panel--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        <div className="sheet__grip" aria-hidden="true" />
        {title ? (
          <header className="sheet__header">
            <div>
              <h2 id={titleId} className="sheet__title">
                {title}
              </h2>
              {subtitle ? <p className="sheet__subtitle">{subtitle}</p> : null}
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              ✕
            </Button>
          </header>
        ) : null}
        <div className="sheet__body">{children}</div>
        {footer ? <footer className="sheet__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * B.11: empty states are never blank panels. They say what is missing and
 * offer the next action.
 */
export function EmptyState({
  title,
  description,
  actions,
  icon,
}: {
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
  readonly icon?: ReactNode;
}) {
  return (
    <div className="state">
      {icon ? <div className="state__icon">{icon}</div> : null}
      <h3 className="state__title">{title}</h3>
      <p className="state__description">{description}</p>
      {actions ? <div className="state__actions">{actions}</div> : null}
    </div>
  );
}

/** B.8: never a generic spinner — the caption always says what is happening. */
export function LoadingState({ label }: { readonly label: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="state__spinner" aria-hidden="true" />
      <p className="state__description">{label}</p>
    </div>
  );
}

export function SuccessState({
  title,
  facts,
  actions,
}: {
  readonly title: string;
  readonly facts?: readonly string[];
  readonly actions?: ReactNode;
}) {
  return (
    <div className="state" role="status">
      <div className="state__tick" aria-hidden="true">
        ✓
      </div>
      <h3 className="state__title">{title}</h3>
      {/* Brief and factual — professional software does not throw confetti. */}
      {facts && facts.length > 0 ? (
        <p className="state__description">{facts.join(' · ')}</p>
      ) : null}
      {actions ? <div className="state__actions">{actions}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  explanation,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  /** Plain-language answer to "why do I need this?" (B.10). */
  readonly explanation?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field__head">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        {explanation ? <Explainer text={explanation} /> : null}
      </div>
      <div className="field__control">
        <div id={id}>{children}</div>
      </div>
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}

function Explainer({ text }: { readonly text: string }) {
  return (
    <details className="explainer">
      <summary className="explainer__summary">? Why do I need this?</summary>
      <p className="explainer__body">{text}</p>
    </details>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  inputMode,
  numeric = false,
  ariaLabel,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly inputMode?: 'text' | 'decimal' | 'numeric';
  readonly numeric?: boolean;
  readonly ariaLabel?: string;
}) {
  return (
    <input
      className={`input ${numeric ? 'numeric' : ''}`}
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export function Toast({
  message,
  tone = 'neutral',
  action,
  onDismiss,
}: {
  readonly message: string;
  readonly tone?: StatusTone;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  readonly onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, action ? 8000 : 4200);
    return () => window.clearTimeout(timer);
  }, [onDismiss, action]);

  return (
    <div className={`toast toast--${tone}`} role="status" aria-live="polite">
      <span className="toast__message">{message}</span>
      {action ? (
        <button type="button" className="toast__action" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress stepper
// ---------------------------------------------------------------------------

export interface Step {
  readonly id: string;
  readonly label: string;
  readonly state: 'pending' | 'active' | 'complete' | 'failed';
}

/**
 * B.8 / B.14: the ○ ● ✓ list. Driven by real pipeline stage events, so it is
 * a report of progress rather than an animation on a timer.
 */
export function ProgressStepper({
  steps,
  compact = false,
}: {
  readonly steps: readonly Step[];
  readonly compact?: boolean;
}) {
  return (
    <ol className={`stepper ${compact ? 'stepper--compact' : ''}`}>
      {steps.map((step) => (
        <li key={step.id} className={`stepper__item stepper__item--${step.state}`}>
          <span className="stepper__glyph" aria-hidden="true">
            {step.state === 'complete'
              ? '✓'
              : step.state === 'failed'
                ? '✕'
                : step.state === 'active'
                  ? '●'
                  : '○'}
          </span>
          <span className="stepper__label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly ariaLabel: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={`segmented__option ${option.value === value ? 'is-active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Card({
  children,
  tone = 'default',
  className = '',
}: {
  readonly children: ReactNode;
  readonly tone?: 'default' | 'sunken' | 'suggested';
  readonly className?: string;
}) {
  return <div className={`card card--${tone} ${className}`}>{children}</div>;
}
