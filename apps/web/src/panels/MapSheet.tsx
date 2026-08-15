/**
 * The survey on a map.
 *
 * This panel is the *only* place in the app that works in latitude and
 * longitude, and it never touches the survey to get them. It asks the engine
 * for a converted copy and draws that. The Minna eastings and northings stay
 * exactly as measured, in the model, on the canvas, in the reports and in
 * every export — they are the survey record, and this is a picture.
 *
 * Everything on screen here says which transformation produced it and how good
 * that transformation is, because the two uses of a position are a few metres
 * apart and it matters enormously which one somebody thinks they are looking
 * at. A national three-parameter datum shift is exactly right for finding a
 * site on a satellite image and exactly wrong for setting a boundary peg.
 */

import { useMemo, useState } from 'react';

import { toGeoJson, wgs84Copy, type Wgs84Plan } from '@surveyor/engine';

import { Button, Card, StatusBadge } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import './panels.css';

export function MapSheet({ onClose }: { readonly onClose: () => void }) {
  const { state } = useProject();
  const [copied, setCopied] = useState(false);

  // Derived, never stored. Recomputed from the survey whenever the survey
  // changes, so the map cannot drift from the plan the way a saved copy would.
  const converted = useMemo(() => wgs84Copy(state.model), [state.model]);

  if (!converted.ok) {
    return (
      <div className="panel">
        <Card tone="sunken">
          <StatusBadge tone="error">Cannot be mapped</StatusBadge>
          <p className="panel__body">{converted.reason}</p>
        </Card>
        <p className="panel__body">
          Your survey is unaffected. Nothing has been converted and nothing has
          been changed — the coordinates on the plan are exactly as you measured
          them.
        </p>
        <div className="panel__footer">
          <Button full variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const { plan } = converted;
  const { centre, transformation } = plan;

  return (
    <div className="panel">
      <Card tone="sunken">
        <p className="panel__body">
          Converted for mapping by <strong>{transformation.name}</strong> (
          {transformation.code}), which is accurate to about{' '}
          <strong>±{transformation.accuracyMetres} m</strong>.
        </p>
        <p className="panel__body">
          Good enough to find the site on a satellite image. Not a substitute
          for the survey: the {state.model.crs.name} coordinates are the record,
          and they have not been altered.
        </p>
      </Card>

      <Outline plan={plan} />

      <div className="mapview__grid">
        <span className="panel__caption">Centre</span>
        <span className="numeric">
          {centre.latitude.toFixed(6)}°, {centre.longitude.toFixed(6)}°
        </span>
      </div>

      {/*
        Opening a real map means leaving the app, which is the honest way to do
        it without shipping a tile layer that would not work on site anyway.
      */}
      <div className="tools__row">
        <Button
          full
          onClick={() =>
            window.open(
              `https://www.openstreetmap.org/?mlat=${centre.latitude}&mlon=${centre.longitude}#map=17/${centre.latitude}/${centre.longitude}`,
              '_blank',
              'noopener,noreferrer',
            )
          }
        >
          OpenStreetMap
        </Button>
        <Button
          full
          onClick={() =>
            window.open(
              `https://www.google.com/maps/search/?api=1&query=${centre.latitude}%2C${centre.longitude}`,
              '_blank',
              'noopener,noreferrer',
            )
          }
        >
          Google Maps
        </Button>
      </div>

      <Button
        full
        variant="primary"
        onClick={() => {
          download(
            `${slug(state.model.metadata.siteAddress)}-wgs84.geojson`,
            JSON.stringify(toGeoJson(plan), null, 2),
            'application/geo+json',
          );
        }}
      >
        Download GeoJSON (WGS 84)
      </Button>

      <Button
        full
        onClick={() => {
          void navigator.clipboard
            ?.writeText(`${centre.latitude.toFixed(7)}, ${centre.longitude.toFixed(7)}`)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? 'Copied' : 'Copy centre for a GPS'}
      </Button>

      {/*
        The beacon list in the mapping frame. Shown alongside, never instead —
        the plan's own coordinate table is the Minna one, and this is a second
        table for a second purpose.
      */}
      <table className="mapview__table">
        <caption className="panel__caption">
          Converted positions — for mapping. The survey coordinates are unchanged.
        </caption>
        <thead>
          <tr>
            <th scope="col">Point</th>
            <th scope="col">Latitude</th>
            <th scope="col">Longitude</th>
          </tr>
        </thead>
        <tbody>
          {plan.points.map((point) => (
            <tr key={point.id}>
              <th scope="row">{point.id}</th>
              <td className="numeric">{point.latitude.toFixed(7)}</td>
              <td className="numeric">{point.longitude.toFixed(7)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="panel__footer">
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * The parcel, drawn in degrees.
 *
 * A shape rather than a map: no tiles, because tiles need a network and this
 * app is used where there is none, and because a basemap nobody asked for is a
 * dependency and a third-party request on every open. What this answers is
 * "did the conversion produce the right shape in the right place", which is
 * the question a surveyor actually has.
 */
function Outline({ plan }: { readonly plan: Wgs84Plan }) {
  const [west, south, east, north] = plan.bounds;

  // Degrees of longitude are shorter than degrees of latitude away from the
  // equator, so the box is corrected for it. Without this a square parcel in
  // Lagos is drawn noticeably wide.
  const cosLat = Math.cos(((north + south) / 2) * (Math.PI / 180));
  const width = Math.max((east - west) * cosLat, 1e-9);
  const height = Math.max(north - south, 1e-9);
  const pad = 0.08;

  const x = (longitude: number) =>
    (((longitude - west) * cosLat) / width) * (1 - 2 * pad) * 100 + pad * 100;
  // SVG y grows downward and latitude grows upward.
  const y = (latitude: number) =>
    (1 - (latitude - south) / height) * (1 - 2 * pad) * 100 + pad * 100;

  return (
    <svg
      className="mapview__outline"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="The parcel in WGS 84, for mapping"
    >
      {plan.features.map((feature) =>
        feature.positions.length < 2 ? null : (
          <polyline
            key={feature.id}
            className="mapview__feature"
            points={feature.positions
              .map((p) => `${x(p.longitude)},${y(p.latitude)}`)
              .join(' ')}
          />
        ),
      )}
      {plan.rings.map((ring) => (
        <polygon
          key={ring.id}
          className="mapview__ring"
          points={ring.positions.map((p) => `${x(p.longitude)},${y(p.latitude)}`).join(' ')}
        />
      ))}
      {plan.points.map((point) => (
        <circle
          key={point.id}
          className="mapview__point"
          cx={x(point.longitude)}
          cy={y(point.latitude)}
          r={1.4}
        />
      ))}
    </svg>
  );
}

function slug(name: string | undefined): string {
  return (name ?? 'survey')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'survey';
}

function download(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
