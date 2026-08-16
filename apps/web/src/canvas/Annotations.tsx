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

import type {
  Coordinates,
  FreeTextBox,
  TitleBlockPart,
  TitleScaleBlock,
} from '@surveyor/contracts';
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
 * The heading: title, scale, bar, origin and area.
 *
 * Laid out the way a lodged survey plan actually lays it out — centred above
 * the drawing, as separate underlined lines, with no box around any of it.
 * That is not a style preference. A plan's heading is a series of distinct
 * statements ("this is the property of…", "scale 1:1000", "origin UTM zone
 * 32", "area 2454.525 sq m"), each underlined so it reads as its own claim,
 * and a surveyor shows, hides and positions them individually. Wrapping them
 * in one bordered plate — which is what this drew before — is a CAD habit
 * that makes a plan look like a screenshot of a program.
 *
 * Each part carries its own `data-id`, so each can be selected and dragged on
 * its own. They still stack automatically until one is moved, so a heading
 * nobody has rearranged stays tidy.
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
  origin,
  area,
  movingPart,
}: AnnotationProps & {
  readonly block: TitleScaleBlock;
  /** What the plan is called, when the block does not override it. */
  readonly title: string;
  /** The scale, computed from the plan when the block does not state one. */
  readonly denominator: number;
  readonly unit: string;
  /** Survey units per screen pixel, for drawing the bar at its true length. */
  readonly worldPerPixel: number;
  /** The coordinate system, as the plan should state it. */
  readonly origin: string;
  /** The computed area, already worded. Null when there is no closed ring. */
  readonly area: string | null;
  /** Which single part is being dragged, if any. */
  readonly movingPart?: TitleBlockPart | undefined;
}) {
  const anchor = project(block.at);

  const bar = scaleBar(denominator, 50, unit);
  /*
   * The bar is drawn at its true length *on screen*, not at its length on
   * paper. A scale bar that did not shrink as you zoomed out would be a
   * measuring stick that lies, which is worse than no bar at all — and this is
   * the one thing on the canvas that has to survive being measured.
   */
  const barPixels = bar.length / Math.max(worldPerPixel, 1e-9);

  /*
   * The stack, built in order and measured as it goes.
   *
   * Line spacing is in pixels rather than survey units on purpose: text is a
   * fixed size on screen, so a heading whose lines drifted apart as you zoomed
   * in would come apart. Only the *position* of the heading is on the ground.
   */
  const rows: {
    readonly part: TitleBlockPart;
    readonly text: string;
    readonly y: number;
    readonly emphasis?: boolean;
    readonly bar?: boolean;
  }[] = [];
  let cursor = 0;

  if (block.showTitle) {
    rows.push({ part: 'title', text: block.title ?? title, y: cursor, emphasis: true });
    cursor += 20;
    if (block.subtitle) {
      // The subtitle belongs to the title and moves with it, so it is drawn
      // as part of that row rather than as a part of its own.
      cursor += 16;
    }
  }
  if (block.showRepresentativeFraction) {
    rows.push({ part: 'fraction', text: representativeFraction(denominator), y: cursor });
    cursor += 20;
  }
  if (block.showScaleBar) {
    rows.push({ part: 'bar', text: bar.label, y: cursor, bar: true });
    cursor += 30;
  }
  if (block.showOrigin) {
    rows.push({ part: 'origin', text: `ORIGIN:- ${origin}`, y: cursor });
    cursor += 20;
  }
  if (block.showArea && area) {
    rows.push({ part: 'area', text: `AREA:- ${area}`, y: cursor });
    cursor += 20;
  }

  /*
   * The stack grows *upward* from the anchor, and this is the whole reason it
   * stays clear of the drawing.
   *
   * The anchor is on the ground, just above the boundary; the lines are text,
   * so their heights are pixels that do not change with zoom. Stacking
   * downward meant the heading's height was fixed while its clearance shrank
   * as you zoomed out — so at any distance the last lines were written across
   * the plan. It was, and the AREA line landed on a boundary dimension.
   *
   * Pinning the *bottom* of the heading to the anchor inverts that: however
   * tall the heading is and whatever the zoom, it occupies the space above the
   * drawing and cannot reach it. The extra gap clears the dimension labels,
   * which sit outside the boundary and are themselves a fixed pixel size.
   */
  const GAP_PX = 22;
  const lift = cursor + GAP_PX;

  return (
    <>
      {rows.map((row) => {
        const own = block.offsets?.[row.part];
        const dragged = moving && offset && (movingPart === undefined || movingPart === row.part);

        /*
         * A part's position: the heading's anchor, plus its own offset if it
         * has been moved, plus a drag in progress. The offset is in survey
         * units like everything else the canvas moves, so dragging a line
         * across the sheet means the same thing at every zoom.
         */
        const de = (own?.de ?? 0) + (dragged ? offset.de : 0);
        const dn = (own?.dn ?? 0) + (dragged ? offset.dn : 0);
        const shifted =
          de === 0 && dn === 0
            ? anchor
            : project({ easting: block.at.easting + de, northing: block.at.northing + dn });

        const id = `${block.id}:${row.part}`;
        const selected = selectedIds.includes(id) || selectedIds.includes(block.id);
        const x = shifted.x;
        const y = shifted.y + row.y - lift;

        // Underline width. Estimated from the text, because measuring real
        // glyphs would need a layout pass per frame — the same estimate the
        // labelling engine uses, and close enough for a rule.
        const width = row.bar ? barPixels : row.text.length * 7.2;

        return (
          <g
            key={row.part}
            className={
              `annotation annotation--title annotation--${row.part}` +
              `${selected ? ' is-selected' : ''}${dragged ? ' is-dragging' : ''}`
            }
            data-id={id}
          >
            {/* An invisible, generous hit target — text is thin to aim at. */}
            <rect
              className="annotation__target"
              x={x - width / 2 - 6}
              y={y - 14}
              width={width + 12}
              height={row.bar ? 34 : 20}
            />

            {row.bar ? (
              <g className="annotation__bar" transform={`translate(${x - barPixels / 2}, ${y})`}>
                <line x1={0} y1={0} x2={barPixels} y2={0} />
                {/* Ticks at the quarters a reader actually takes off it. */}
                {bar.ticks.map((tick) => {
                  const tickX = (tick / Math.max(bar.length, 1e-9)) * barPixels;
                  return <line key={tick} x1={tickX} y1={-4} x2={tickX} y2={4} />;
                })}
                <text className="annotation__bar-label" x={0} y={16} textAnchor="middle">
                  0
                </text>
                <text className="annotation__bar-label" x={barPixels} y={16} textAnchor="middle">
                  {bar.label}
                </text>
              </g>
            ) : (
              <>
                <text
                  className={`annotation__text${row.emphasis ? ' annotation__text--title' : ''}`}
                  x={x}
                  y={y}
                  textAnchor="middle"
                  style={styleOf(block.style)}
                >
                  {row.text}
                </text>
                {/*
                  The underline, which is the plan's own convention and not a
                  decoration: it is what separates one statement from the next
                  where there is no box to do it.
                */}
                <line
                  className="annotation__rule"
                  x1={x - width / 2}
                  y1={y + 3}
                  x2={x + width / 2}
                  y2={y + 3}
                />
                {row.part === 'title' && block.subtitle ? (
                  <text
                    className="annotation__text"
                    x={x}
                    y={y + 16}
                    textAnchor="middle"
                    style={styleOf(block.style)}
                  >
                    {block.subtitle}
                  </text>
                ) : null}
              </>
            )}

            {selected ? (
              <rect
                className="annotation__outline"
                x={x - width / 2 - 6}
                y={y - 14}
                width={width + 12}
                height={row.bar ? 34 : 20}
                rx={2}
              />
            ) : null}
          </g>
        );
      })}
    </>
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
