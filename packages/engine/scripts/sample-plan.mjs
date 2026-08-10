/**
 * Renders a sample plan to SVG, PDF and DXF.
 *
 * Useful as a smoke test you can actually look at: `node scripts/sample-plan.mjs`
 * writes into ./sample-output.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planToDxf,
  planToPdf,
  planToSvg,
  ringFromPointOrder,
  runPipeline,
} from '../dist/index.js';

const outputDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'sample-output');

const model = {
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
          { easting: 534795, northing: 182896 },
          { easting: 534836, northing: 182900 },
        ],
      },
      attributes: { name: 'High Street' },
      provenance: { source: 'measured' },
    },
  ],
  notes: [{ id: 'n1', text: 'Boundary as occupied at date of survey.', provenance: { source: 'user-confirmed' } }],
};

const result = runPipeline(model, {
  onStage: (event) => {
    if (event.state === 'complete') console.log(`  ✓ ${event.message}`);
  },
});

if (!result.ok) {
  console.error(`Pipeline stopped at ${result.failedAt}: ${result.message}`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'plan.svg'), planToSvg(result.plan));
writeFileSync(join(outputDir, 'plan.pdf'), planToPdf(result.plan));
writeFileSync(join(outputDir, 'plan.dxf'), planToDxf(result.plan));

console.log(`
Sheet:  ${result.plan.sheet.id} ${result.plan.sheet.orientation}`);
console.log(`Scale:  1:${result.plan.transform.scaleDenominator}`);
console.log(`Area:   ${result.rings[0].area.toFixed(1)} m²`);
console.log(`Labels: ${result.plan.labels.length} (${result.plan.labels.filter((l) => l.outcome === 'dropped').length} dropped)`);
console.log(`Status: ${result.validation.status}`);
console.log(`Output: ${outputDir}`);
