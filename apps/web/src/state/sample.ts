/**
 * The project the app opens with.
 *
 * A worked example beats an empty canvas for judging whether the tool does what
 * you need — and the empty path is still one tap away via "Start a new plan".
 */

import type { SurveyDataModel } from '@surveyor/contracts';
import { DEFAULT_CRS, DEFAULT_JURISDICTION, ringFromPointOrder } from '@surveyor/engine';

export const SAMPLE_PROJECT: SurveyDataModel = {
  metadata: {
    jurisdiction: DEFAULT_JURISDICTION,
    siteAddress: 'Plot 15, Adeola Close, Ikeja, Lagos',
    client: 'A. Client',
    jobNumber: 'LA/2026/1042',
    surveyor: 'R. Surveyor MNIS',
    date: '2026-08-10',
  },
  /*
   * Minna / UTM zone 31N — the same system the blank sheet starts on, so the
   * worked example and a new plan agree about what a coordinate means.
   */
  crs: DEFAULT_CRS,
  points: [
    { id: 'PT1', coordinates: { easting: 544800, northing: 718900 }, provenance: { source: 'measured' } },
    { id: 'PT2', coordinates: { easting: 544832.4, northing: 718903.1 }, provenance: { source: 'measured' } },
    { id: 'PT3', coordinates: { easting: 544828.9, northing: 718924.6 }, provenance: { source: 'measured' } },
    { id: 'PT4', coordinates: { easting: 544798.2, northing: 718921.3 }, provenance: { source: 'measured' } },
  ],
  boundary: [ringFromPointOrder('ring_1', ['PT1', 'PT2', 'PT3', 'PT4'])],
  siteFeatures: [
    {
      id: 'bld_1',
      type: 'building',
      geometry: {
        kind: 'polygon',
        vertices: [
          { easting: 544807, northing: 718907 },
          { easting: 544819, northing: 718908.2 },
          { easting: 544818, northing: 718916 },
          { easting: 544806, northing: 718914.8 },
        ],
      },
      attributes: { name: 'House' },
      provenance: { source: 'measured' },
    },
    {
      id: 'road_1',
      type: 'road',
      geometry: {
        kind: 'polyline',
        vertices: [
          { easting: 544794, northing: 718895.6 },
          { easting: 544837, northing: 718899.8 },
        ],
      },
      attributes: { name: 'Adeola Close' },
      provenance: { source: 'measured' },
    },
  ],
  notes: [
    {
      id: 'note_1',
      text: 'Boundary as occupied at date of survey.',
      provenance: { source: 'user-confirmed' },
    },
  ],
};
