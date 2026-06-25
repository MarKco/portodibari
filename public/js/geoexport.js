// ── Geospatial export (client-side) ─────────────────────────────────────────
// Turns data already loaded in the browser into GeoJSON (.geojson, for QGIS/web)
// or KML (.kml, for Google Earth) and triggers a download — same client-side
// Blob approach as the CSV export. Coordinates are emitted as [lon, lat] (the
// GeoJSON/KML order), converted from the app's lat/lon.
//
// Internal feature shape: { geometry: {type, coordinates}, props: {} }.
// Geometry types used: Point, LineString, Polygon (coordinates already [lon,lat]).

function download(filename, mime, text) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toGeoJSON(features) {
  return JSON.stringify(
    { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: f.props || {} })) },
    null,
    2
  );
}

const xmlEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const coord = (c) => (c[2] != null ? `${c[0]},${c[1]},${c[2]}` : `${c[0]},${c[1]}`);

function kmlGeometry(g) {
  if (g.type === 'Point') return `<Point><coordinates>${coord(g.coordinates)}</coordinates></Point>`;
  if (g.type === 'LineString') return `<LineString><tessellate>1</tessellate><coordinates>${g.coordinates.map(coord).join(' ')}</coordinates></LineString>`;
  if (g.type === 'Polygon') return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${g.coordinates[0].map(coord).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
  return '';
}

function toKML(features, docName) {
  const placemarks = features
    .map((f) => {
      const props = f.props || {};
      const name = props.name != null ? props.name : props.mmsi != null ? props.mmsi : '';
      const data = Object.entries(props)
        .map(([k, v]) => `<Data name="${xmlEsc(k)}"><value>${xmlEsc(v)}</value></Data>`)
        .join('');
      return `  <Placemark><name>${xmlEsc(name)}</name>${data ? `<ExtendedData>${data}</ExtendedData>` : ''}${kmlGeometry(f.geometry)}</Placemark>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document><name>${xmlEsc(docName)}</name>\n${placemarks}\n</Document>\n</kml>`;
}

// Emit `features` in the requested format (`'geojson'` | `'kml'`) under a
// timestamped filename. Returns the feature count (0 → caller can warn "empty").
function emit(features, fmt, baseName) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (fmt === 'kml') download(`${baseName}-${ts}.kml`, 'application/vnd.google-earth.kml+xml', toKML(features, baseName));
  else download(`${baseName}-${ts}.geojson`, 'application/geo+json', toGeoJSON(features));
  return features.length;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// ── Builders ────────────────────────────────────────────────────────────────

// Current filtered ship list → one Point per positioned ship.
export function exportShips(ships, fmt, prefix = 'navi') {
  const features = (ships || [])
    .filter((s) => num(s.last_latitude) != null && num(s.last_longitude) != null)
    .map((s) => ({
      geometry: { type: 'Point', coordinates: [Number(s.last_longitude), Number(s.last_latitude)] },
      props: {
        name: s.ship_name || String(s.mmsi),
        mmsi: s.mmsi,
        ship_type: s.ship_type ?? '',
        destination: s.destination || '',
        sog_kn: s.last_sog ?? '',
        cog: s.last_cog ?? '',
        in_port: s.in_port ? 'yes' : 'no',
        risk_score: s.risk?.score ?? '',
        risk_band: s.risk?.band ?? '',
        flagged: s.flagged ? 'yes' : 'no',
        military: s.is_military ? 'yes' : 'no',
        imo: s.imo_number || '',
        call_sign: s.call_sign || '',
        last_seen_at: s.last_seen_at || '',
      },
    }));
  return emit(features, fmt, prefix);
}

// A single ship's track → a LineString through the fixes + a Point per fix
// (carrying the timestamp, for time-aware tools).
export function exportTrack(points, meta, fmt) {
  const pts = (points || [])
    .filter((p) => num(p.latitude) != null && num(p.longitude) != null)
    .map((p) => ({ p, ll: [Number(p.longitude), Number(p.latitude)] }));
  const name = meta?.name || String(meta?.mmsi || 'track');
  const features = [];
  if (pts.length >= 2) {
    features.push({ geometry: { type: 'LineString', coordinates: pts.map((x) => x.ll) }, props: { name: `${name} — track`, mmsi: meta?.mmsi ?? '', points: pts.length } });
  }
  for (const { p, ll } of pts) {
    features.push({ geometry: { type: 'Point', coordinates: ll }, props: { name, mmsi: meta?.mmsi ?? '', time: p.received_at || '', sog_kn: p.sog ?? '', cog: p.cog ?? '' } });
  }
  return emit(features, fmt, `traccia-${meta?.mmsi || ''}`);
}

// Replay window (grouped-by-ship positions) → one LineString per ship.
export function exportReplay(data, fmt, area = 'area') {
  const features = [];
  for (const sh of (data?.ships || [])) {
    const fixes = (sh.fixes || [])
      .filter((f) => num(f.lat) != null && num(f.lon) != null)
      .sort((a, b) => new Date(a.t) - new Date(b.t));
    if (fixes.length < 2) continue;
    features.push({
      geometry: { type: 'LineString', coordinates: fixes.map((f) => [Number(f.lon), Number(f.lat)]) },
      props: { name: sh.name || String(sh.mmsi), mmsi: sh.mmsi, risk_band: sh.band || '', fixes: fixes.length, from: fixes[0].t, to: fixes[fixes.length - 1].t },
    });
  }
  return emit(features, fmt, `replay-${area}`);
}

// Detected/drawn berths → one Polygon per berth (ring closed for GeoJSON).
export function exportBerths(berths, fmt, area = 'area') {
  const features = [];
  for (const b of (berths || [])) {
    let ring;
    try {
      ring = JSON.parse(b.polygon_json); // [[lat,lon], …]
    } catch {
      ring = null;
    }
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const coords = ring.map((pt) => [Number(pt[1]), Number(pt[0])]); // → [lon,lat]
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first); // close ring
    features.push({
      geometry: { type: 'Polygon', coordinates: [coords] },
      props: { name: b.name || `berth ${b.id}`, category: b.char_override || b.char_label || '', moorings: b.mooring_count ?? '', hazmat_pct: b.hazmat_pct ?? '' },
    });
  }
  return emit(features, fmt, `banchine-${area}`);
}
