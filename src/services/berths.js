'use strict';

// Berth detection & characterisation.
//
// Pipeline (per area):
//   1. detectMoorings — one point per ship visit = centroid of that ship's
//      stationary readings during the visit window. Tagged with ship category.
//   2. cluster — DBSCAN over mooring points (haversine, eps metres) groups
//      points into berths. Points inside a *manual* berth polygon are assigned
//      to it first and excluded from clustering, so hand-drawn geometry wins.
//   3. characterise — tally categories per berth; the dominant one (≥ pct) names
//      it, else "mixed"; below MIN_MOORINGS it stays uncharacterised.
//
// Auto berths are rebuilt from scratch every recompute, but a renamed/overridden
// auto berth keeps its identity by matching the new cluster centroid to the old
// one within eps. Manual berths (geometry locked by the user) are never moved.

const db = require('../db');
const appLog = require('./app-log');
const userPrefs = require('./user-prefs');
const { BERTH } = require('../config');

// Berth lifecycle alerts fan out to every user who monitors the area whose
// personal prefs enable that alert type (prefKey = notifyBerthNew|notifyBerthChar).
function notifyAreaOwners(area, prefKey, notif) {
  const telegram = require('./telegram'); // lazy: avoids a load-time cycle
  const webhooks = require('./webhooks');
  for (const uid of db.getAreaOwners(area)) {
    const p = userPrefs.get(uid);
    if (p.notificationsEnabled && p[prefKey]) {
      db.addNotification({ user_id: uid, ...notif });
    }
    // Telegram has its own per-category toggle, independent of the in-app one.
    // lat/lon drive the static map + the "open in map" link; the berth centroid
    // travels in notif.berth_lat / notif.berth_lon.
    const evp = { area, band: notif.band, ship_name: notif.ship_name, lat: notif.berth_lat, lon: notif.berth_lon, berth_id: notif.berth_id };
    telegram.notifyBerth(uid, notif.type, evp);
    webhooks.dispatch(uid, notif.type, evp);
  }
}
const { categoryOf, isHazmat } = require('./ship-categories');

const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

// ── Geometry helpers ─────────────────────────────────────────────────────────
const R = 6371000; // Earth radius (m)
const toRad = (d) => (d * Math.PI) / 180;

function haversineM(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Convex hull (Andrew's monotone chain) of [lat,lon] points → ordered ring of
// [lat,lon]. For 1–2 points (or all-collinear) returns a small square buffer
// around the centroid so the berth is always a drawable polygon.
function convexHull(points) {
  const uniq = [];
  const seen = new Set();
  for (const p of points) {
    const k = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(p);
    }
  }
  if (uniq.length < 3) {
    const cLat = uniq.reduce((s, p) => s + p.lat, 0) / uniq.length;
    const cLon = uniq.reduce((s, p) => s + p.lon, 0) / uniq.length;
    return bufferSquare(cLat, cLon, 20);
  }
  // x = lon, y = lat
  const pts = uniq.map((p) => [p.lon, p.lat]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const ring = lower.concat(upper); // [lon,lat] CCW
  if (ring.length < 3) {
    const cLat = uniq.reduce((s, p) => s + p.lat, 0) / uniq.length;
    const cLon = uniq.reduce((s, p) => s + p.lon, 0) / uniq.length;
    return bufferSquare(cLat, cLon, 20);
  }
  return ring.map(([lon, lat]) => [lat, lon]);
}

// Square ring of half-side `m` metres around a point, as [lat,lon] vertices.
function bufferSquare(lat, lon, m) {
  const dLat = (m / R) * (180 / Math.PI);
  const dLon = (m / (R * Math.cos(toRad(lat)))) * (180 / Math.PI);
  return [
    [lat - dLat, lon - dLon],
    [lat - dLat, lon + dLon],
    [lat + dLat, lon + dLon],
    [lat + dLat, lon - dLon],
  ];
}

// Ray-casting point-in-polygon. `ring` = [[lat,lon],...] (x=lon, y=lat).
function pointInPolygon(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0],
      xi = ring[i][1];
    const yj = ring[j][0],
      xj = ring[j][1];
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function centroidOf(points) {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { lat, lon };
}

// ── DBSCAN ─────────────────────────────────────────────────────────────────
// Density clustering with haversine distance. Returns an array of clusters
// (each an array of the input points). Noise points are dropped.
//
// Neighbour lookup is accelerated with a uniform grid: points are bucketed into
// cells of side ~epsM, so the candidates for a point are only its own cell plus
// the 8 adjacent ones — turning the previous O(n²) all-pairs scan into roughly
// O(n) for the spatially-spread mooring sets seen in practice.
function dbscan(points, epsM, minPts) {
  const n = points.length;
  if (!n) return [];

  // Fixed degrees-per-cell for the whole set (a port area spans little latitude,
  // so one reference latitude keeps cell boundaries consistent).
  const latDeg = epsM / 111320;
  const refLat = points.reduce((s, p) => s + p.lat, 0) / n;
  const lonDeg = epsM / (111320 * Math.max(Math.cos(toRad(refLat)), 1e-6));
  const cellX = (p) => Math.floor(p.lon / lonDeg);
  const cellY = (p) => Math.floor(p.lat / latDeg);
  const cellKey = (cx, cy) => `${cx},${cy}`;

  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = cellKey(cellX(points[i]), cellY(points[i]));
    const arr = grid.get(k);
    if (arr) arr.push(i);
    else grid.set(k, [i]);
  }

  const neighbours = (i) => {
    const out = [];
    const cx = cellX(points[i]);
    const cy = cellY(points[i]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get(cellKey(cx + dx, cy + dy));
        if (!arr) continue;
        for (const j of arr) {
          if (j === i) continue;
          if (haversineM(points[i].lat, points[i].lon, points[j].lat, points[j].lon) <= epsM)
            out.push(j);
        }
      }
    }
    return out;
  };

  const visited = new Array(n).fill(false);
  const assigned = new Array(n).fill(false);
  const clusters = [];

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const nbrs = neighbours(i);
    if (nbrs.length + 1 < minPts) continue; // noise (for now)
    const cluster = [i];
    assigned[i] = true;
    const queue = [...nbrs];
    const inQueue = new Set(queue);
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q];
      if (!visited[j]) {
        visited[j] = true;
        const jn = neighbours(j);
        if (jn.length + 1 >= minPts) for (const k of jn) if (!inQueue.has(k)) { inQueue.add(k); queue.push(k); }
      }
      if (!assigned[j]) {
        assigned[j] = true;
        cluster.push(j);
      }
    }
    clusters.push(cluster.map((idx) => points[idx]));
  }
  return clusters;
}

// ── Mooring detection ────────────────────────────────────────────────────────
// One mooring per arrival: the centroid of the ship's stationary readings
// between this arrival and its next arrival in the same area. Visits with no
// stationary reading (pure transit) are skipped.
function detectMoorings(area) {
  const arrivals = db.getArrivalsForArea(area); // ordered by mmsi, ts
  const moorings = [];
  for (let i = 0; i < arrivals.length; i++) {
    const a = arrivals[i];
    const next = arrivals[i + 1];
    const endTs = next && next.mmsi === a.mmsi ? next.ts : FAR_FUTURE;
    const c = db.getStayCentroid(a.mmsi, area, a.ts, endTs);
    if (!c || !c.n || c.lat == null || c.lon == null) continue;
    moorings.push({
      mmsi: a.mmsi,
      ship_type: a.ship_type ?? null,
      category: categoryOf(a.ship_type),
      lat: c.lat,
      lon: c.lon,
      ts: a.ts,
    });
  }
  return moorings;
}

// Merge-based mooring sync: moorings for departed ships are kept permanently
// (even after their readings are pruned), only ships still in port get their
// centroid refreshed, and new arrivals are added. Orphaned moorings (whose
// arrival was deleted from port_events) are removed.
//
// Returns the moorings this call actually inserted or repositioned — brand-new
// arrivals, and ships still in port whose centroid just moved. Everyone else
// (departed, unchanged since last sync) is untouched on purpose: their cluster
// membership can't have changed, so recomputeAreaIncremental() uses this list
// to know exactly which moorings might need re-evaluating instead of every
// mooring the area has ever recorded.
function syncMoorings(area) {
  const arrivals = db.getArrivalsForArea(area); // ordered by mmsi, ts
  const arrivalKeys = new Set(arrivals.map((a) => `${a.mmsi}:${a.ts}`));
  const existing = new Map(db.getMoorings(area).map((m) => [`${m.mmsi}:${m.ts}`, m]));

  // Remove moorings whose arrival was deleted from port_events.
  for (const [key, m] of existing) {
    if (!arrivalKeys.has(key)) db.deleteMooring(m.id);
  }

  const touched = [];
  for (let i = 0; i < arrivals.length; i++) {
    const a = arrivals[i];
    const key = `${a.mmsi}:${a.ts}`;
    const next = arrivals[i + 1];
    const endTs = next && next.mmsi === a.mmsi ? next.ts : FAR_FUTURE;
    const cur = existing.get(key);

    // Departed ship with existing mooring: centroid is final, don't re-read.
    if (cur && endTs !== FAR_FUTURE) continue;

    // Ship still in port or new arrival: compute centroid while readings are fresh.
    const c = db.getStayCentroid(a.mmsi, area, a.ts, endTs);
    if (!c || !c.n || c.lat == null || c.lon == null) continue;

    if (cur) {
      db.updateMooringPosition(cur.id, c.lat, c.lon);
      touched.push({ id: cur.id, lat: c.lat, lon: c.lon, berth_id: cur.berth_id });
    } else {
      const id = db.addMooring(area, a.mmsi, a.ship_type ?? null, categoryOf(a.ship_type), c.lat, c.lon, a.ts);
      touched.push({ id, lat: c.lat, lon: c.lon, berth_id: null });
    }
  }
  return touched;
}

// ── Characterisation ─────────────────────────────────────────────────────────
function characterize(members) {
  const count = members.length;
  const tally = {};
  let hazmat = 0;
  for (const m of members) {
    tally[m.category] = (tally[m.category] || 0) + 1;
    if (isHazmat(m.ship_type)) hazmat++;
  }
  const dist = Object.entries(tally)
    .map(([category, n]) => ({ category, n, pct: Math.round((n / count) * 100) }))
    .sort((a, b) => b.n - a.n);
  const hazmatPct = Math.round((hazmat / count) * 100);

  let label = null; // uncharacterised until enough samples
  if (count >= BERTH.MIN_MOORINGS) {
    const top = dist[0];
    label =
      top && top.category !== 'unknown' && top.pct >= BERTH.DOMINANT_PCT ? top.category : 'mixed';
  }
  return { label, dist, count, hazmatPct };
}

// ── Recompute ──────────────────────────────────────────────────────────────
// Full rebuild: every mooring the area has ever recorded is reset to
// unclustered and re-clustered from scratch. Correct by construction (handles
// arbitrary manual-polygon edits/merges, always converges to the same result),
// but its cost grows with the area's ENTIRE mooring history — fine for the rare,
// explicit admin actions that call it (create/edit/merge/delete a berth, the
// manual "recompute now" button, post-restore), disastrous on a fixed timer for
// a busy area (see recomputeAreaIncremental below, which is what the periodic
// timer and dirty-flush actually use).
//
// skipSync: true → skip mooring sync (use the moorings table as-is).
// Used post-restore when moorings were already restored from a backup.
function recomputeAreaFull(area, { skipSync = false } = {}) {
  if (!skipSync) syncMoorings(area); // merge-based update
  const pendingNotify = [];
  db.runTransaction(() => {
    db.clearMooringBerths(area); // berth_id reset to NULL so re-clustering starts clean
    const stored = db.getMoorings(area); // now with ids

    const oldAuto = db.getAutoBerths(area); // capture renamed/overridden identity
    const manualBerths = db.getBerths(area).filter((b) => b.manual_geom);

    // Berth lifecycle notifications. The very first recompute on an empty area
    // would otherwise flag every freshly seeded berth as "new"/"characterised";
    // suppress that initial burst (no prior berths of any kind = seeding).
    const initialSeed = oldAuto.length === 0 && manualBerths.length === 0;
    // Per-user gating happens in notifyAreaOwners; here we only suppress the
    // initial seeding burst (no prior berths of any kind).
    const emitNew = !initialSeed;
    const emitChar = !initialSeed;

    // 1) Assign points inside a manual polygon to that berth (hand-drawn wins).
    const claimed = new Set();
    for (const b of manualBerths) {
      let ring;
      try {
        ring = JSON.parse(b.polygon_json);
      } catch {
        ring = null;
      }
      if (!ring) continue;
      const members = stored.filter((m) => !claimed.has(m.id) && pointInPolygon(m.lat, m.lon, ring));
      members.forEach((m) => claimed.add(m.id));
      db.setMooringBerth(
        members.map((m) => m.id),
        b.id
      );
      const wasUnchar = !b.char_label;
      const ch = characterize(members);
      db.updateBerthChar(b.id, {
        char_label: ch.label,
        mooring_count: ch.count,
        dist_json: JSON.stringify(ch.dist),
        hazmat_pct: ch.hazmatPct,
      });
      if (emitChar && wasUnchar && ch.label) {
        pendingNotify.push(['notifyBerthChar', { type: 'berth_characterized', area, berth_id: b.id, berth_lat: b.centroid_lat, berth_lon: b.centroid_lon, ship_name: b.name, band: ch.label }]);
      }
    }

    // 2) Cluster the rest into auto berths.
    const pool = stored.filter((m) => !claimed.has(m.id));
    const clusters = dbscan(pool, BERTH.CLUSTER_EPS_M, BERTH.MIN_PTS);

    db.deleteAutoBerths(area);

    const usedOld = new Set();
    for (const members of clusters) {
      const c = centroidOf(members);
      // Inherit name/override/identity from the nearest old auto berth. The match
      // radius is widened to 2× eps so a cluster whose centroid drifts a little
      // between recomputes still keeps its identity — otherwise it would be
      // treated as brand-new and re-fire a "new berth" notification every cycle.
      let inherit = null;
      let best = Infinity;
      for (const ob of oldAuto) {
        if (usedOld.has(ob.id)) continue;
        const d = haversineM(c.lat, c.lon, ob.centroid_lat, ob.centroid_lon);
        if (d < best && d <= BERTH.CLUSTER_EPS_M * 2) {
          best = d;
          inherit = ob;
        }
      }
      if (inherit) usedOld.add(inherit.id);

      const ch = characterize(members);
      const id = db.insertBerth({
        area,
        name: inherit ? inherit.name : null,
        polygon_json: JSON.stringify(convexHull(members)),
        centroid_lat: c.lat,
        centroid_lon: c.lon,
        manual_geom: 0,
        char_label: ch.label,
        char_override: inherit ? inherit.char_override : null,
        mooring_count: ch.count,
        dist_json: JSON.stringify(ch.dist),
        hazmat_pct: ch.hazmatPct,
      });
      db.setMooringBerth(
        members.map((m) => m.id),
        id
      );

      // Notify: a brand-new berth (no inherited identity) → "new"; an existing
      // berth that just crossed the characterisation threshold → "characterised".
      if (!inherit) {
        if (emitNew) {
          pendingNotify.push(['notifyBerthNew', { type: 'berth_new', area, berth_id: id, berth_lat: c.lat, berth_lon: c.lon, ship_name: null, band: ch.label || null }]);
        }
      } else if (emitChar && !inherit.char_label && ch.label) {
        pendingNotify.push(['notifyBerthChar', { type: 'berth_characterized', area, berth_id: id, berth_lat: c.lat, berth_lon: c.lon, ship_name: inherit.name, band: ch.label }]);
      }
    }
  });

  // Fired only after the transaction commits: notifyAreaOwners does Telegram/
  // webhook network I/O, which must never run with the write lock still held.
  for (const [prefKey, notif] of pendingNotify) notifyAreaOwners(area, prefKey, notif);

  return { moorings: db.getMoorings(area).length, berths: db.getBerths(area).length };
}

// Incremental rebuild: touches only moorings that (a) have no berth yet — new
// arrivals, or points that stayed noise below MIN_PTS last cycle — or (b)
// belong to a ship still in port whose centroid syncMoorings just moved enough
// to fall outside its current berth. Every other mooring (the vast majority
// once an area has been running a while — departed ships already stably
// clustered) is left completely untouched: no re-fetch, no re-cluster, no
// write. This is what makes the periodic timer and dirty-flush sweep cheap
// regardless of how much history an area has accumulated — the old code
// reset+re-clustered EVERY mooring the area ever had on every single run,
// which for a busy area (tens of thousands of moorings) meant redoing years of
// already-settled clustering work every 2 minutes, blocking the single Node
// thread long enough to also starve the AIS WebSocket's heartbeat handling.
function recomputeAreaIncremental(area, { skipSync = false } = {}) {
  // DIAGNOSTICA TEMPORANEA (picchi CPU periodici, vedi indagine 2026-08-22).
  const __t0 = Date.now();
  const touched = skipSync ? [] : syncMoorings(area);
  const __syncMs = Date.now() - __t0;

  // A repositioned mooring's existing berth may no longer fit — release it
  // back into the pool so it gets re-evaluated below. Cost is bounded by how
  // many ships are CURRENTLY in port (small), never by total history.
  for (const t of touched) {
    if (t.berth_id == null) continue;
    const b = db.getBerth(t.berth_id);
    const stillFits = b && berthContains(b, t.lat, t.lon);
    if (!stillFits) db.setMooringBerth([t.id], null);
  }

  const __poolT0 = Date.now();
  const pool = db.getUnclusteredMoorings(area);
  const __poolMs = Date.now() - __poolT0;
  if (!pool.length) {
    if (__syncMs > 200 || __poolMs > 200) appLog.warn('PERF', `berths[${area}] incrementale: sync=${__syncMs}ms pool=${__poolMs}ms touched=${touched.length} unclustered=0`);
    return { moorings: db.getMoorings(area).length, berths: db.getBerths(area).length };
  }

  const manualBerths = db.getBerths(area).filter((b) => b.manual_geom);
  const autoBerths = db.getAutoBerths(area);
  const pendingNotify = [];
  const claimed = new Set();

  const __txT0 = Date.now();
  db.runTransaction(() => {
    // 1) Manual polygons still win first claim — but only over the (small)
    // pool, not the area's whole history: an already-clustered point is never
    // reconsidered here (see recomputeAreaFull's stronger guarantee for that).
    for (const b of manualBerths) {
      let ring;
      try {
        ring = JSON.parse(b.polygon_json);
      } catch {
        ring = null;
      }
      if (!ring) continue;
      const members = pool.filter((m) => !claimed.has(m.id) && pointInPolygon(m.lat, m.lon, ring));
      if (!members.length) continue;
      members.forEach((m) => claimed.add(m.id));
      db.setMooringBerth(members.map((m) => m.id), b.id);
      const wasUnchar = !b.char_label;
      const merged = db.getMooringsByBerth(b.id); // old + newly-claimed members
      const ch = characterize(merged);
      db.updateBerthChar(b.id, { char_label: ch.label, mooring_count: ch.count, dist_json: JSON.stringify(ch.dist), hazmat_pct: ch.hazmatPct });
      if (wasUnchar && ch.label) {
        pendingNotify.push(['notifyBerthChar', { type: 'berth_characterized', area, berth_id: b.id, berth_lat: b.centroid_lat, berth_lon: b.centroid_lon, ship_name: b.name, band: ch.label }]);
      }
    }

    // 2) Try attaching the rest to an existing auto berth (within eps of its
    // current centroid) instead of re-running DBSCAN over the whole area.
    const rest = pool.filter((m) => !claimed.has(m.id));
    const touchedBerths = new Set();
    for (const m of rest) {
      let best = null;
      let bestD = Infinity;
      for (const b of autoBerths) {
        const d = haversineM(m.lat, m.lon, b.centroid_lat, b.centroid_lon);
        if (d < bestD && d <= BERTH.CLUSTER_EPS_M) {
          bestD = d;
          best = b;
        }
      }
      if (best) {
        claimed.add(m.id);
        db.setMooringBerth([m.id], best.id);
        touchedBerths.add(best.id);
      }
    }
    // Re-characterise + recentre every auto berth that gained a member.
    for (const berthId of touchedBerths) {
      const b = autoBerths.find((x) => x.id === berthId);
      const merged = db.getMooringsByBerth(berthId);
      const wasUnchar = !b.char_label;
      const ch = characterize(merged);
      const c = centroidOf(merged);
      db.updateBerthAutoGeom(berthId, { centroid_lat: c.lat, centroid_lon: c.lon, polygon_json: JSON.stringify(convexHull(merged)) });
      db.updateBerthChar(berthId, { char_label: ch.label, mooring_count: ch.count, dist_json: JSON.stringify(ch.dist), hazmat_pct: ch.hazmatPct });
      if (wasUnchar && ch.label) {
        pendingNotify.push(['notifyBerthChar', { type: 'berth_characterized', area, berth_id: berthId, berth_lat: c.lat, berth_lon: c.lon, ship_name: b.name, band: ch.label }]);
      }
    }

    // 3) Whatever's left matched no manual polygon and no existing berth —
    // genuinely new territory. Cluster just this leftover (small) pool to spot
    // brand-new berths; anything below MIN_PTS stays noise and is simply
    // reconsidered again next cycle once more points land nearby.
    const orphans = rest.filter((m) => !claimed.has(m.id));
    const clusters = dbscan(orphans, BERTH.CLUSTER_EPS_M, BERTH.MIN_PTS);
    for (const members of clusters) {
      const c = centroidOf(members);
      const ch = characterize(members);
      const id = db.insertBerth({
        area,
        name: null,
        polygon_json: JSON.stringify(convexHull(members)),
        centroid_lat: c.lat,
        centroid_lon: c.lon,
        manual_geom: 0,
        char_label: ch.label,
        char_override: null,
        mooring_count: ch.count,
        dist_json: JSON.stringify(ch.dist),
        hazmat_pct: ch.hazmatPct,
      });
      db.setMooringBerth(members.map((m) => m.id), id);
      pendingNotify.push(['notifyBerthNew', { type: 'berth_new', area, berth_id: id, berth_lat: c.lat, berth_lon: c.lon, ship_name: null, band: ch.label || null }]);
    }
  });

  const __txMs = Date.now() - __txT0;
  const __totalMs = Date.now() - __t0;
  if (__totalMs > 200) {
    appLog.warn('PERF', `berths[${area}] incrementale: totale=${__totalMs}ms sync=${__syncMs}ms getPool=${__poolMs}ms transazione=${__txMs}ms touched=${touched.length} unclustered=${pool.length} autoBerths=${autoBerths.length} manualBerths=${manualBerths.length}`);
  }

  for (const [prefKey, notif] of pendingNotify) notifyAreaOwners(area, prefKey, notif);
  return { moorings: db.getMoorings(area).length, berths: db.getBerths(area).length };
}

// A point "still fits" a berth if it's inside the manual polygon (manual
// berths) or within clustering radius of the centroid (auto berths) — same
// membership rule recomputeAreaFull's clustering pass would apply.
function berthContains(berth, lat, lon) {
  if (berth.manual_geom) {
    let ring;
    try {
      ring = JSON.parse(berth.polygon_json);
    } catch {
      return false;
    }
    return ring ? pointInPolygon(lat, lon, ring) : false;
  }
  return haversineM(lat, lon, berth.centroid_lat, berth.centroid_lon) <= BERTH.CLUSTER_EPS_M;
}

// Manual admin actions (create/edit/merge/delete a berth, the "recompute now"
// button, post-restore) always get the full, from-scratch rebuild — they're
// rare and need the stronger correctness guarantee (e.g. a resized manual
// polygon must be able to reclaim points currently owned by a DIFFERENT
// berth, which the incremental pool-only pass never reconsiders). The
// automated paths (periodic timer, dirty-flush) explicitly opt into the fast
// incremental pass instead — see server.js and startDirtyFlush() below.
function recomputeArea(area, { skipSync = false, full = false } = {}) {
  return full || skipSync ? recomputeAreaFull(area, { skipSync }) : recomputeAreaIncremental(area, { skipSync });
}

function recomputeAll({ skipSync = false, full = false } = {}) {
  const { BBOX_PRESETS } = require('../config');
  const out = {};
  for (const area of Object.keys(BBOX_PRESETS)) {
    try {
      out[area] = recomputeArea(area, { skipSync, full });
    } catch (e) {
      appLog.error('BERTHS', appLog.t('berths.recompute_failed', { area, error: e.message }), { area });
    }
  }
  return out;
}

// ── Incremental "dirty" recompute ────────────────────────────────────────────
// Arrivals/departures change an area's mooring set. Rather than recompute every
// area on a fixed timer, the AIS ingestion marks the affected area dirty and a
// short-interval flush recomputes only those — keeping the berth list fresh
// without a full sweep on every tick.
const dirtyAreas = new Set();
let flushTimer = null;

function markAreaDirty(area) {
  if (area) dirtyAreas.add(area);
}

function flushDirtyAreas() {
  if (!dirtyAreas.size) return;
  const areas = [...dirtyAreas];
  dirtyAreas.clear();
  appLog.info('BERTHS', appLog.t('berths.recompute_incremental'), { aree: areas });
  for (const area of areas) {
    try {
      recomputeArea(area);
    } catch (e) {
      appLog.error('BERTHS', appLog.t('berths.recompute_incremental_failed', { area, error: e.message }), { area });
    }
  }
}

/** Start the periodic flush of dirty areas (idempotent). */
function startDirtyFlush() {
  if (flushTimer) return;
  flushTimer = setInterval(flushDirtyAreas, BERTH.DIRTY_FLUSH_MIN * 60 * 1000);
}

module.exports = {
  detectMoorings,
  syncMoorings,
  characterize,
  recomputeArea,
  recomputeAll,
  markAreaDirty,
  flushDirtyAreas,
  startDirtyFlush,
  // exposed for tests / reuse
  dbscan,
  convexHull,
  pointInPolygon,
  haversineM,
};
