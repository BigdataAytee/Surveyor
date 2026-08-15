/**
 * A slippy map, hand-rolled.
 *
 * Not a mapping library. Leaflet or MapLibre would each add a few hundred
 * kilobytes and a second interaction model to an app that is already a canvas
 * with its own gestures — and all that is needed here is: put these tiles in a
 * grid, put this parcel on top, let a thumb move it. That is the file below,
 * and the arithmetic it rests on lives in the engine where it is tested.
 *
 * Two things it is careful about.
 *
 * The parcel is drawn from the converted WGS 84 copy and nothing else. No
 * survey coordinate reaches this file; it never has and never will get near
 * the model.
 *
 * Tiles need a network, and this app is used where there is none. When they
 * cannot be fetched the map does not break — the parcel outline is drawn on
 * the background it always had, and the map says why it is blank rather than
 * leaving a grey square that looks like a bug.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fromWorldPixel,
  tileUrl,
  tilesFor,
  toWorldPixel,
  zoomForBounds,
  type Wgs84Plan,
} from '@surveyor/engine';

import { DEFAULT_LAYER_ID, MAP_LAYERS, layerById, type MapLayer } from './map-layers.js';
import { loadPreferences, savePreferences } from '../state/preferences.js';
import './tile-map.css';

export function TileMap({ plan }: { readonly plan: Wgs84Plan }) {
  /*
   * Which basemap, remembered.
   *
   * A surveyor who works from imagery works from imagery on every job, and
   * having to say so again on every plan is the app not paying attention. It
   * is a preference about them, not about the survey, so it goes where the
   * other ones do and never near the model.
   */
  const [layerId, setLayerId] = useState<MapLayer['id']>(
    () => layerById(loadPreferences().mapLayer ?? DEFAULT_LAYER_ID).id,
  );
  const layer = layerById(layerId);

  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<{
    readonly latitude: number;
    readonly longitude: number;
    readonly zoom: number;
  } | null>(null);
  /** Tiles that failed to load, so the map can say the imagery is missing. */
  const [failed, setFailed] = useState(0);

  /*
   * A layer whose tiles are 512 pixels, or whose origin is at the bottom of
   * the world, would draw a convincing map with the boundary in the wrong
   * field. Checked rather than assumed, because that is the one way switching
   * layers could move the parcel and it would not look like an error.
   */
  if (layer.tileSize !== 256) {
    throw new Error(`Map layer “${layer.label}” is not on the 256-pixel tile grid.`);
  }

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (size.width === 0) return;
    setView({
      latitude: plan.centre.latitude,
      longitude: plan.centre.longitude,
      zoom: Math.floor(zoomForBounds(plan.bounds, size.width, size.height)),
    });
  }, [plan, size.width, size.height]);

  // Fitted once the viewport has been measured, and again if the survey moves
  // — but not on every pan, or the map would spring back under the finger.
  useEffect(() => {
    if (size.width > 0 && view === null) fit();
  }, [fit, size.width, view]);

  const tiles = useMemo(
    () =>
      view === null || size.width === 0
        ? []
        : // The layer's own depth limit. Past it the last real level is
          // stretched rather than requesting tiles the provider does not have.
          tilesFor(view, view.zoom, size.width, size.height, layer.maxZoom),
    [view, size.width, size.height, layer.maxZoom],
  );

  /** A position to a pixel in this viewport. */
  const project = useCallback(
    (latitude: number, longitude: number): { x: number; y: number } => {
      if (!view) return { x: 0, y: 0 };
      const point = toWorldPixel(latitude, longitude, view.zoom);
      const middle = toWorldPixel(view.latitude, view.longitude, view.zoom);
      return {
        x: size.width / 2 + (point.x - middle.x),
        y: size.height / 2 + (point.y - middle.y),
      };
    },
    [view, size.width, size.height],
  );

  // --- Gestures -------------------------------------------------------------

  /**
   * Live pointers, by id.
   *
   * A ref rather than state: these are read and written many times per frame
   * inside the same event, and a re-render between two of them would read a
   * stale position — the exact bug that made the sidebar's swipe never close.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);

  function pan(dx: number, dy: number): void {
    setView((current) => {
      if (!current) return current;
      const middle = toWorldPixel(current.latitude, current.longitude, current.zoom);
      const moved = fromWorldPixel({ x: middle.x - dx, y: middle.y - dy }, current.zoom);
      return { ...moved, zoom: current.zoom };
    });
  }

  function zoomBy(delta: number, at?: { x: number; y: number }): void {
    setView((current) => {
      if (!current) return current;
      const zoom = Math.max(1, Math.min(21, current.zoom + delta));
      if (zoom === current.zoom) return current;
      if (!at) return { ...current, zoom };

      /*
       * Zoom about the point under the fingers, not the centre of the screen.
       * Anything else slides the thing being examined out of view, which on a
       * phone means chasing it.
       */
      const before = fromWorldPixel(
        {
          x: toWorldPixel(current.latitude, current.longitude, current.zoom).x + (at.x - size.width / 2),
          y: toWorldPixel(current.latitude, current.longitude, current.zoom).y + (at.y - size.height / 2),
        },
        current.zoom,
      );
      const anchor = toWorldPixel(before.latitude, before.longitude, zoom);
      const centre = fromWorldPixel(
        { x: anchor.x - (at.x - size.width / 2), y: anchor.y - (at.y - size.height / 2) },
        zoom,
      );
      return { ...centre, zoom };
    });
  }

  return (
    <div className="tilemap">
      <div
        ref={host}
        className="tilemap__viewport"
        role="application"
        aria-label="The survey on a map"
        onPointerDown={(event) => {
          (event.target as Element).setPointerCapture?.(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

          const live = [...pointers.current.values()];

          if (live.length >= 2) {
            // Pinch. One finger moving while two are down is not a pan.
            const [a, b] = live;
            const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
            const rect = host.current?.getBoundingClientRect();
            const midpoint = {
              x: (a!.x + b!.x) / 2 - (rect?.left ?? 0),
              y: (a!.y + b!.y) / 2 - (rect?.top ?? 0),
            };

            if (pinch.current === null) {
              pinch.current = { distance, zoom: view?.zoom ?? 0 };
              return;
            }
            const ratio = distance / Math.max(1, pinch.current.distance);
            zoomBy(Math.log2(ratio) - (view ? view.zoom - pinch.current.zoom : 0), midpoint);
            return;
          }

          pan(event.clientX - previous.x, event.clientY - previous.y);
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          pinch.current = null;
        }}
        onWheel={(event) => {
          const rect = host.current?.getBoundingClientRect();
          zoomBy(event.deltaY < 0 ? 1 : -1, {
            x: event.clientX - (rect?.left ?? 0),
            y: event.clientY - (rect?.top ?? 0),
          });
        }}
      >
        {tiles.map((tile) => (
          <img
            key={`${layer.id}/${tile.z}/${tile.x}/${tile.y}`}
            className="tilemap__tile"
            src={tileUrl(layer.template, tile)}
            alt=""
            aria-hidden="true"
            draggable={false}
            loading="lazy"
            // A tile is decorative imagery from another origin; nothing about
            // this page needs to travel with the request.
            referrerPolicy="no-referrer"
            onError={(event) => {
              /*
               * Hidden rather than left as a broken image. A tile that could
               * not load otherwise draws the browser's placeholder border, and
               * a viewport full of those looks like a fault in this app rather
               * than like the absence of a network. The element is keyed by
               * tile, so a later tile at the same position is a new element and
               * starts visible again.
               */
              event.currentTarget.style.visibility = 'hidden';
              setFailed((count) => count + 1);
            }}
            style={{
              left: `${tile.left}px`,
              top: `${tile.top}px`,
              width: `${tile.size}px`,
              height: `${tile.size}px`,
            }}
          />
        ))}

        {/* The parcel, from the converted copy. Never from the survey. */}
        {view ? (
          <svg className="tilemap__overlay" aria-hidden="true">
            {plan.features.map((feature) =>
              feature.positions.length < 2 ? null : (
                <polyline
                  key={feature.id}
                  className="tilemap__feature"
                  points={feature.positions
                    .map((p) => {
                      const { x, y } = project(p.latitude, p.longitude);
                      return `${x},${y}`;
                    })
                    .join(' ')}
                />
              ),
            )}
            {plan.rings.map((ring) => (
              <polygon
                key={ring.id}
                className="tilemap__ring"
                points={ring.positions
                  .map((p) => {
                    const { x, y } = project(p.latitude, p.longitude);
                    return `${x},${y}`;
                  })
                  .join(' ')}
              />
            ))}
            {plan.points.map((point) => {
              const { x, y } = project(point.latitude, point.longitude);
              return <circle key={point.id} className="tilemap__point" cx={x} cy={y} r={4} />;
            })}
          </svg>
        ) : null}

        {/*
          Said plainly rather than left as a grey rectangle. On site with no
          signal this is the expected state, not a fault, and the parcel above
          is still exactly where it should be.
        */}
        {failed > 0 && tiles.length > 0 ? (
          <p className="tilemap__note" role="status">
            Map imagery needs a connection. Your parcel is drawn from the
            converted coordinates and does not.
          </p>
        ) : null}
        {/*
          The layer switcher.
          
          Inside the viewport rather than under it, because it is a control for
          the map and belongs on the map — and on a phone the sheet below it
          scrolls, which would leave the switcher somewhere else on the screen
          from the thing it switches.
        */}
        <div className="tilemap__layers" role="group" aria-label="Map imagery">
          {MAP_LAYERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`tilemap__layer${option.id === layer.id ? ' is-active' : ''}`}
              aria-pressed={option.id === layer.id}
              onClick={() => {
                /*
                 * Only the imagery changes. The view — centre and zoom — is
                 * left exactly as it is, so the parcel stays under the same
                 * pixels and the surveyor keeps looking at what they were
                 * looking at. Re-fitting here would be the app deciding it
                 * knows better than the person who just panned somewhere.
                 */
                setLayerId(option.id);
                setFailed(0);
                savePreferences({ ...loadPreferences(), mapLayer: option.id });
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tilemap__controls">
        {/*
          Named for the map specifically. The drawing canvas has its own zoom
          controls, and two buttons on one screen answering to "Zoom in" is a
          coin toss for anyone driving this by voice or by screen reader.
        */}
        <button type="button" aria-label="Zoom in on the map" onClick={() => zoomBy(1)}>
          +
        </button>
        <button type="button" aria-label="Zoom out on the map" onClick={() => zoomBy(-1)}>
          −
        </button>
        <button type="button" aria-label="Fit the map to the survey" onClick={fit}>
          ⊡
        </button>
      </div>

      {/*
        Required, not decorative. OpenStreetMap's licence obliges anything
        showing its tiles to credit it, and a map that quietly drops the credit
        is using somebody's work against their terms.
      */}
      <p className="tilemap__attribution">
        {layer.attribution}
        {view ? <span className="tilemap__zoom"> · zoom {Math.round(view.zoom)}</span> : null}
      </p>
    </div>
  );
}
