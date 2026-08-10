/**
 * The project the app opens with.
 *
 * A worked example beats an empty canvas for judging whether the tool does what
 * you need — and the empty path is still one tap away via "Start a new plan".
 */

import type { SurveyDataModel } from '@surveyor/contracts';
import { ringFromPointOrder } from '@surveyor/engine';

export const SAMPLE_PROJECT: SurveyDataModel = {
  metadata: {
    jurisdiction: 'uk-land-registry',
    siteAddress: '25 High Street, Fairview',
    client: 'A. Client',
    jobNumber: 'J-1042',
    surveyor: 'R. Surveyor MRICS',
    date: '2026-08-10',
  },
  crs: {
    code: 'EPSG:27700',
    name: 'OSGB36 / British National Grid',
    datum: 'OSGB36',
    units: 'metre',
    bearingConvention: 'quadrant',
  },
  points: [
    { id: 'PT1', coordinates: { easting: 534800, northing: 182900 }, provenance: { source: 'measured' } },
    { id: 'PT2', coordinates: { easting: 534832.4, northing: 182903.1 }, provenance: { source: 'measured' } },
    { id: 'PT3', coordinates: { easting: 534828.9, northing: 182924.6 }, provenance: { source: 'measured' } },
    { id: 'PT4', coordinates: { easting: 534798.2, northing: 182921.3 }, provenance: { source: 'measured' } },
  ],
  boundary: [ringFromPointOrder('ring_1', ['PT1', 'PT2', 'PT3', 'PT4'])],
  siteFeatures: [
    {
      id: 'bld_1',
      type: 'building',
      geometry: {
        kind: 'polygon',
        vertices: [
          { easting: 534807, northing: 182907 },
          { easting: 534819, northing: 182908.2 },
          { easting: 534818, northing: 182916 },
          { easting: 534806, northing: 182914.8 },
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
          { easting: 534794, northing: 182895.6 },
          { easting: 534837, northing: 182899.8 },
        ],
      },
      attributes: { name: 'High Street' },
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
