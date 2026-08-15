/**
 * Tests for the basemap layers.
 *
 * The thing worth guarding is not that two URLs exist. It is that both layers
 * are on the *same* tile scheme, because the overlay — the boundary, the
 * beacons — is positioned from the view alone and assumes the imagery beneath
 * it is laid out the standard way. A provider with 512-pixel tiles, or a TMS
 * origin at the bottom of the world, would draw an entirely convincing map
 * with the parcel in the wrong field. Nothing on screen would look wrong.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { tileUrl, tilesFor, toWorldPixel } from '@surveyor/engine';

import {
  DEFAULT_LAYER_ID,
  MAP_LAYERS,
  SATELLITE,
  STREETS,
  layerById,
} from '../src/panels/map-layers.js';

test('both layers are offered, and OpenStreetMap is still the default', () => {
  const ids = MAP_LAYERS.map((layer) => layer.id);
  assert.deepEqual(ids, ['streets', 'satellite']);

  assert.equal(DEFAULT_LAYER_ID, 'streets');
  assert.equal(layerById(undefined).id, 'streets');
  assert.equal(layerById('nonsense').id, 'streets', 'an unknown layer fell through to nothing');
});

test('adding satellite did not displace OpenStreetMap', () => {
  assert.match(STREETS.template, /openstreetmap\.org/);
  assert.match(STREETS.attribution, /OpenStreetMap/);
  assert.equal(layerById('streets').template, STREETS.template);
});

test('the satellite layer is imagery, and credits its source', () => {
  assert.equal(SATELLITE.id, 'satellite');
  assert.match(SATELLITE.template, /World_Imagery/);
  // Attribution is a licence condition for this one too.
  assert.match(SATELLITE.attribution, /Esri/);
  assert.ok(SATELLITE.attribution.length > 10);
});

test('every layer is on the same 256-pixel Web Mercator grid', () => {
  for (const layer of [STREETS, SATELLITE, ...MAP_LAYERS]) {
    assert.equal(layer.tileSize, 256, `${layer.id} is not on a 256-pixel grid`);
    assert.ok(layer.maxZoom >= 17, `${layer.id} cannot zoom in far enough for a parcel`);
    assert.ok(layer.maxZoom <= 22, `${layer.id} claims a depth no provider has`);
  }
});

test('a tile URL fills in for either layer, including Esri’s row-before-column path', () => {
  const tile = { z: 17, x: 62_940, y: 62_540 };

  assert.equal(
    tileUrl(STREETS.template, tile),
    'https://tile.openstreetmap.org/17/62940/62540.png',
  );

  /*
   * Esri puts the row before the column. Substituting by name rather than by
   * position is what makes that a difference in the template and not a bug —
   * and getting it backwards would fetch a real tile from the wrong place,
   * which looks like imagery of somewhere else entirely.
   */
  assert.equal(
    tileUrl(SATELLITE.template, tile),
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/17/62540/62940',
  );

  for (const layer of MAP_LAYERS) {
    assert.ok(!/\{[zxys]\}/.test(tileUrl(layer.template, tile)), `${layer.id} left a placeholder`);
  }
});

test('switching layer cannot move anything, because the overlay does not depend on it', () => {
  /*
   * The structural version of the guarantee. A position's pixel comes from the
   * view — centre and zoom — and from nothing else; there is no layer argument
   * to pass and therefore nothing to get wrong. The browser suite checks the
   * rendered result; this checks that the arithmetic has no seam for a layer
   * to reach through.
   */
  const here = { latitude: 6.5042673, longitude: 3.4043964 };
  const first = toWorldPixel(here.latitude, here.longitude, 19);
  const second = toWorldPixel(here.latitude, here.longitude, 19);
  assert.deepEqual(first, second);

  // And the tile *grid* is identical for two layers of the same depth, so the
  // imagery lines up with itself across a switch as well.
  const centre = { latitude: 6.5042, longitude: 3.4052 };
  const streets = tilesFor(centre, 19, 360, 340, STREETS.maxZoom);
  const satellite = tilesFor(centre, 19, 360, 340, SATELLITE.maxZoom);
  assert.deepEqual(
    streets.map(({ z, x, y, left, top, size }) => ({ z, x, y, left, top, size })),
    satellite.map(({ z, x, y, left, top, size }) => ({ z, x, y, left, top, size })),
  );
});

test('past a layer’s depth the last real level is stretched, not requested beyond', () => {
  const centre = { latitude: 6.5042, longitude: 3.4052 };

  // Asking for 21 from a provider that has 19.
  const tiles = tilesFor(centre, 21, 360, 340, 19);
  assert.ok(tiles.length > 0);
  for (const tile of tiles) {
    assert.equal(tile.z, 19, `asked for zoom ${tile.z} from a provider that stops at 19`);
    // Drawn four times the size, which is what "zoomed in two levels" means.
    assert.ok(Math.abs(tile.size - 1024) < 1e-6, `tile drawn at ${tile.size}px`);
  }
});

test('a layer with no depth limit behaves as it did before', () => {
  const centre = { latitude: 6.5042, longitude: 3.4052 };
  assert.deepEqual(tilesFor(centre, 18, 360, 340), tilesFor(centre, 18, 360, 340, 22));
});
