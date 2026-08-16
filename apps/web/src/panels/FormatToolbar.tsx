/**
 * Formatting, as two small toolbars.
 *
 * One component each for text and lines, reused everywhere rather than
 * reimplemented per object. They are sections *inside* whatever panel already
 * appears when something is selected — never a second popup — so a surveyor
 * who knows how to edit a boundary already knows where formatting lives.
 *
 * The hard rule these hold to: formatting is presentation and touches nothing
 * else. Every control here dispatches `set-text-style` or `set-line-style`,
 * and those two reducer cases are structurally incapable of reaching a
 * coordinate, a calculated value or a provenance tag. A bold dimension is the
 * same dimension.
 */

import type { LineStyle, TextStyle } from '@surveyor/contracts';

import { Button, Field } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import './panels.css';

/**
 * The palette.
 *
 * Deliberately small and named. A full colour picker on a survey plan invites
 * a drawing in twelve colours that photocopies to twelve identical greys —
 * these are the ones that stay distinguishable in black and white, which is
 * how most plans are still read.
 */
const COLOURS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'Default', value: '' },
  { label: 'Black', value: '#111827' },
  { label: 'Red', value: '#b91c1c' },
  { label: 'Blue', value: '#1d4ed8' },
  { label: 'Green', value: '#15803d' },
  { label: 'Grey', value: '#6b7280' },
];

/** Cap heights a plan actually uses, in the units the canvas draws at. */
const SIZES: readonly number[] = [10, 12, 14, 18, 24];

export function TextFormatToolbar({
  id,
  style,
}: {
  readonly id: string;
  readonly style: TextStyle | undefined;
}) {
  const { dispatch } = useProject();
  const set = (patch: TextStyle) => dispatch({ type: 'set-text-style', id, style: patch });

  return (
    <Field
      label="Formatting"
      hint="Changes how this is drawn. It does not change what it says or where it sits."
    >
      <div className="format">
        <div className="format__row">
          <Button
            size="sm"
            variant={style?.bold ? 'primary' : 'secondary'}
            aria-pressed={style?.bold ?? false}
            onClick={() => set({ bold: !style?.bold })}
          >
            Bold
          </Button>
          <Button
            size="sm"
            variant={style?.italic ? 'primary' : 'secondary'}
            aria-pressed={style?.italic ?? false}
            onClick={() => set({ italic: !style?.italic })}
          >
            Italic
          </Button>
        </div>

        <div className="format__row">
          <label className="format__label" htmlFor={`${id}-size`}>
            Size
          </label>
          <select
            id={`${id}-size`}
            className="panel__select"
            aria-label="Text size"
            value={style?.fontSize ?? ''}
            onChange={(event) =>
              set(
                event.target.value === ''
                  ? // Cleared back to the drawing's default rather than to a
                    // number that happens to match it — so a later change of
                    // default carries this along with it.
                    {}
                  : { fontSize: Number(event.target.value) },
              )
            }
          >
            <option value="">Default</option>
            {SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        <ColourRow
          id={`${id}-colour`}
          value={style?.color}
          onPick={(color) => set(color === '' ? {} : { color })}
        />
      </div>
    </Field>
  );
}

export function LineFormatToolbar({
  id,
  style,
}: {
  readonly id: string;
  readonly style: LineStyle | undefined;
}) {
  const { dispatch } = useProject();
  const set = (patch: LineStyle) => dispatch({ type: 'set-line-style', id, style: patch });

  return (
    <Field
      label="Formatting"
      hint="Changes how this is drawn. It does not change its position, length or bearing."
    >
      <div className="format">
        <div className="format__row">
          <Button
            size="sm"
            variant={style?.dashed ? 'primary' : 'secondary'}
            aria-pressed={style?.dashed ?? false}
            onClick={() => set({ dashed: !style?.dashed })}
          >
            Dashed
          </Button>
        </div>

        <div className="format__row">
          <label className="format__label" htmlFor={`${id}-width`}>
            Width
          </label>
          <select
            id={`${id}-width`}
            className="panel__select"
            aria-label="Line width"
            value={style?.strokeWidth ?? ''}
            onChange={(event) =>
              set(
                event.target.value === ''
                  ? {}
                  : { strokeWidth: Number(event.target.value) },
              )
            }
          >
            <option value="">Default</option>
            {[0.25, 0.35, 0.5, 0.7, 1].map((width) => (
              <option key={width} value={width}>
                {width} mm
              </option>
            ))}
          </select>
        </div>

        <ColourRow
          id={`${id}-colour`}
          value={style?.color}
          onPick={(color) => set(color === '' ? {} : { color })}
        />
      </div>
    </Field>
  );
}

function ColourRow({
  id,
  value,
  onPick,
}: {
  readonly id: string;
  readonly value: string | undefined;
  readonly onPick: (colour: string) => void;
}) {
  return (
    <div className="format__row" role="group" aria-label="Colour">
      {COLOURS.map((colour) => (
        <button
          key={colour.value || 'default'}
          type="button"
          id={colour.value === '' ? id : undefined}
          className={`format__swatch${(value ?? '') === colour.value ? ' is-active' : ''}`}
          aria-label={colour.label}
          aria-pressed={(value ?? '') === colour.value}
          title={colour.label}
          onClick={() => onPick(colour.value)}
          style={colour.value === '' ? undefined : { background: colour.value }}
        >
          {colour.value === '' ? 'A' : ''}
        </button>
      ))}
    </div>
  );
}
