/**
 * The annotation layer: the title/scale block and free text boxes.
 *
 * These are not survey data. They sit on the sheet at a position the surveyor
 * chose, they carry no provenance beyond "a person put this here", and nothing
 * about them feeds the geometry — moving a text box changes no bearing, no
 * area and no coordinate. That separation is the whole reason they are drawn
 * here rather than added to the element layer.
 *
 * They *are* positioned in survey coordinates rather than screen pixels, which
 * is not a contradiction: an annotation pinned to the screen would slide over
 * the drawing on every pan, and a note reading "fence in poor repair" is about
 * a place. It travels with the plan; it is simply not part of it.
 *
 * Selection and dragging reuse the canvas's existing machinery — `data-id` for
 * hit-testing, `offset` for a drag in progress — rather than introducing a
 * second interaction model beside it.
 */

import type { Coordinates, FreeTextBox, TitleScaleBlock } from '@surveyor/contracts';
import { representativeFraction, scaleBar } from '@surveyor/engine';

/** Screen position of a survey coordinate. */
type Project = (at: Coordinates) => { readonly x: number; readonly y: number };

export interface AnnotationProps {
  readonly project: Project;
  readonly selectedIds: readonly string[];
  /**
   * A drag in progress, in *survey units* — the same shape the element layer
   * uses, so both move by the same arithmetic rather than two that have to be
   * kept agreeing.
   */
  readonly offset?: { readonly de: number; readonly dn: number } | undefined;
  /** Whether this annotation is one of the things being dragged. */
  readonly moving?: boolean;
}

/**
 * A free text box.
 *
 * Drawn with a halo behind it so it reads over a boundary line, a building or
 * a hatched area without needing a filled box that would hide what it is
 * annotating.
 */
export function TextBoxMark({
  box,
  project,
  selectedIds,
  offset,
  moving,
}: AnnotationProps & { readonly box: FreeTextBox }) {
  const dragging = moving && offset;
  const at = project(
    dragging
      ? { easting: box.at.easting + offset.de, northing: box.at.northing + offset.dn }
      : box.at,
  );
  const selected = selectedIds.includes(box.id);
  const { x, y } = at;

  return (
    <g
      className={`annotation annotation--text${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`}
      data-id={box.id}
    >
      {/*
        A generous transparent rectangle behind the text.

        Text is thin, and a hit target the exact width of the glyphs is a
        target that has to be aimed at. This is what a finger actually lands
        on; it is invisible and it is not a background.
      */}
      <rect
        className="annotation__target"
        x={x - 6}
        y={y - 14}
        width={Math.max(28, box.text.length * 7 + 12)}
        height={20}
      />
      {box.text.split('\n').map((line, index) => (
        <text
          key={index}
          className="annotation__text"
          x={x}
          y={y + index * 14}
          style={styleOf(box.style)}
        >
          {line}
        </text>
      ))}
      {selected ? <rect className="annotation__outline" x={x - 6} y={y - 14} width={Math.max(28, box.text.length * 7 + 12)} height={20 + (box.text.split('\n').length - 1) * 14} /> : null}
    </g>
  );
}

/**
 * The title, the representative fraction and the scale bar.
 *
 * One `<g>`, one `data-id`, one thing to tap — because they are one statement
 * about the drawing. Which parts show is the surveyor's choice; what they say
 * comes from the plan unless they have overridden it.
 */
export function TitleBlockMark({
  block,
  project,
  selectedIds,
  offset,
  moving,
  title,
  denominator,
  unit,
  worldPerPixel,
}: AnnotationProps & {
  readonly block: TitleScaleBlock;
  /** What the plan is called, when the block does not override it. */
  readonly title: string;
  /** The scale, computed from the plan when the block does not state one. */
  readonly denominator: number;
  readonly unit: string;
  /** Survey units per screen pixel, for drawing the bar at its true length. */
  readonly worldPerPixel: number;
}) {
  const dragging = moving && offset;
  const at = project(
    dragging
      ? { easting: block.at.easting + offset.de, northing: block.at.northing + offset.dn }
      : block.at,
  );
  const selected = selectedIds.includes(block.id);
  const { x, y } = at;

  const bar = scaleBar(denominator, 50, unit);
  /*
   * The bar is drawn at its true length *on screen*, not at its length on
   * paper. A scale bar that did not shrink as you zoomed out would be a
   * measuring stick that lies, which is worse than no bar at all — and this is
   * the one thing on the canvas that has to survive being measured.
   */
  const barPixels = bar.length / Math.max(worldPerPixel, 1e-9);

  const lines: string[] = [];
  if (block.showTitle) lines.push(block.title ?? title);
  if (block.subtitle) lines.push(block.subtitle);
  if (block.showRepresentativeFraction) lines.push(representativeFraction(denominator));

  const height = lines.length * 15 + (block.showScaleBar ? 26 : 0) + 12;
  const width = Math.max(
    barPixels + 16,
    ...lines.map((line) => line.length * 7 + 16),
    120,
  );

  return (
    <g
      className={`annotation annotation--title${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`}
      data-id={block.id}
    >
      <rect className="annotation__plate" x={x} y={y} width={width} height={height} rx={3} />

      {lines.map((line, index) => (
        <text
          key={index}
          className={`annotation__text${index === 0 && block.showTitle ? ' annotation__text--title' : ''}`}
          x={x + 8}
          y={y + 18 + index * 15}
          style={styleOf(block.style)}
        >
          {line}
        </text>
      ))}

      {block.showScaleBar ? (
        <g className="annotation__bar" transform={`translate(${x + 8}, ${y + lines.length * 15 + 18})`}>
          {/* The bar, with its ticks at the quarters a reader takes off it. */}
          <line x1={0} y1={0} x2={barPixels} y2={0} />
          {bar.ticks.map((tick) => {
            const tickX = (tick / Math.max(bar.length, 1e-9)) * barPixels;
            return <line key={tick} x1={tickX} y1={-4} x2={tickX} y2={4} />;
          })}
          <text className="annotation__bar-label" x={0} y={16}>
            0
          </text>
          <text className="annotation__bar-label" x={barPixels} y={16} textAnchor="end">
            {bar.label}
          </text>
        </g>
      ) : null}

      {selected ? (
        <rect className="annotation__outline" x={x} y={y} width={width} height={height} rx={3} />
      ) : null}
    </g>
  );
}

/**
 * A style, as SVG presentation attributes.
 *
 * Only what has been set. An absent field must produce no attribute at all, so
 * the stylesheet's own value applies and an unstyled annotation looks exactly
 * like one drawn before styling existed.
 */
function styleOf(style: FreeTextBox['style']): React.CSSProperties {
  if (!style) return {};
  return {
    ...(style.fontSize === undefined ? {} : { fontSize: `${style.fontSize}px` }),
    ...(style.bold === undefined ? {} : { fontWeight: style.bold ? 700 : 400 }),
    ...(style.italic === undefined ? {} : { fontStyle: style.italic ? 'italic' : 'normal' }),
    ...(style.color === undefined ? {} : { fill: style.color }),
  };
}
