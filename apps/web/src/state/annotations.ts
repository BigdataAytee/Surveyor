/**
 * Making a title block and a text box.
 *
 * One place, because two callers need it: the Add panel, where a surveyor asks
 * for one directly, and the assistant, where a card offers it. The
 * architecture is explicit that the button and the chat command must call the
 * same code path rather than diverge — this file is that path, and neither
 * caller builds one of these itself.
 */

import type { Coordinates, FreeTextBox, SurveyDataModel, TitleScaleBlock } from '@surveyor/contracts';

/** Ids that read as what they are when they turn up in a selection. */
function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Where a new annotation goes.
 *
 * The two kinds want different places, and giving them the same one was a real
 * bug: a note created straight after a title block landed underneath its
 * plate, where it could not be tapped and looked like nothing had happened.
 *
 *   - A title block goes below and left of the drawing's extent, which is
 *     where it belongs on a sheet and where it obscures nothing.
 *   - A note goes *inside* the extent, near the top-left, because a note is
 *     about a place on the plan — "fence in poor repair" belongs by the fence.
 *     It is dragged there; it starts somewhere immediately visible.
 *
 * Falls back to the origin on a plan with no geometry: an annotation on an
 * empty sheet has nowhere better to be, and it can be dragged.
 */
export function annotationAnchor(
  model: SurveyDataModel,
  bounds: { readonly min: Coordinates; readonly max: Coordinates } | null,
  /** Offsets successive notes so they do not land on top of each other. */
  index = 0,
  kind: 'title-block' | 'text' = 'title-block',
): Coordinates {
  if (!bounds) return { easting: 0, northing: -5 * index };

  const height = bounds.max.northing - bounds.min.northing;
  const width = bounds.max.easting - bounds.min.easting;
  const margin = Math.max(height * 0.08, 2);

  if (kind === 'title-block') {
    return { easting: bounds.min.easting, northing: bounds.min.northing - margin };
  }

  /*
   * A step large enough to clear a line of text at any sensible zoom. Sized
   * from the drawing rather than fixed, because a plan of a compound and a
   * plan of a farm are two orders of magnitude apart and a step in metres
   * that suits one is invisible or absurd on the other.
   */
  const step = Math.max(height * 0.12, 1);

  return {
    easting: bounds.min.easting + Math.max(width * 0.06, 1),
    northing: bounds.max.northing - Math.max(height * 0.1, 1) - index * step,
  };
}

/**
 * A title block with nothing decided.
 *
 * Every content field is absent on purpose. Absent means "read it from the
 * plan", so a block created this way follows the survey — rename the site and
 * the title follows — until the surveyor types something, and from that moment
 * it is theirs and nothing regenerates it.
 */
export function makeTitleBlock(
  at: Coordinates,
  parts: {
    readonly title?: boolean;
    readonly representativeFraction?: boolean;
    readonly scaleBar?: boolean;
  } = {},
): TitleScaleBlock {
  return {
    id: id('title'),
    at,
    showTitle: parts.title ?? true,
    showRepresentativeFraction: parts.representativeFraction ?? true,
    showScaleBar: parts.scaleBar ?? true,
    /*
     * `user-confirmed`, because a title block is not a claim about the ground.
     * It restates what the plan already says, and marking it `ai-suggested`
     * would block the export gate over the fact that a heading exists.
     */
    provenance: { source: 'user-confirmed' },
  };
}

export function makeTextBox(at: Coordinates, text: string): FreeTextBox {
  return {
    id: id('text'),
    text,
    at,
    provenance: { source: 'user-confirmed' },
  };
}

/**
 * Turn on the parts of a block that are missing, leaving the rest alone.
 *
 * What "Add scale bar" does to a block that already has a title. It is
 * additive by construction: it can turn a part on and can never turn one off,
 * and it never touches the text or the scale a surveyor has typed.
 */
export function withParts(
  block: TitleScaleBlock,
  parts: {
    readonly title?: boolean;
    readonly representativeFraction?: boolean;
    readonly scaleBar?: boolean;
  },
): Partial<TitleScaleBlock> {
  return {
    ...(parts.title ? { showTitle: true } : {}),
    ...(parts.representativeFraction ? { showRepresentativeFraction: true } : {}),
    ...(parts.scaleBar ? { showScaleBar: true } : {}),
  };
}
