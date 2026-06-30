'use strict';

// One-shot migration: for each ship+source (sf/mst), walk readings ordered by
// received_at and identify "stationary clusters" — consecutive rows whose
// positions all remain within RADIUS_M of the cluster's first point. Keeps the
// first and last row of each cluster, deletes the intermediate ones.
//
// Usage:
//   node scripts/migration_cluster_sfmst.js              # apply
//   node scripts/migration_cluster_sfmst.js --dry-run    # preview, no writes
//   node scripts/migration_cluster_sfmst.js --radius=500 # custom radius (default 200m)

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DRY_RUN = process.argv.includes('--dry-run');
const RADIUS_M = parseFloat(process.argv.find((a) => a.startsWith('--radius='))?.slice(9)) || 200;
const DB_PATH = path.join(__dirname, '..', 'data', 'db', 'ais_data.db');

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const db = new DatabaseSync(DB_PATH);

const ships = db
  .prepare(`SELECT DISTINCT mmsi, source FROM readings WHERE source IN ('sf','mst') AND latitude IS NOT NULL ORDER BY mmsi, source`)
  .all();

console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}Radius: ${RADIUS_M}m — checking ${ships.length} (mmsi, source) pairs`);

let totalDeleted = 0;

const deleteStmt = DRY_RUN ? null : db.prepare('DELETE FROM readings WHERE id = ?');

for (const { mmsi, source } of ships) {
  const rows = db
    .prepare(`SELECT id, received_at, latitude AS lat, longitude AS lon FROM readings WHERE mmsi = ? AND source = ? AND latitude IS NOT NULL ORDER BY received_at ASC`)
    .all(mmsi, source);

  if (rows.length <= 1) continue;

  // Walk rows comparing each against the current cluster's anchor (first point).
  // When a row exceeds RADIUS_M, close the old cluster and start a new one.
  // Keep: cluster[0] (first) and cluster[last] — delete everything in between.
  const toDelete = [];
  let clusterStart = 0;

  for (let i = 1; i < rows.length; i++) {
    const d = haversineM(rows[clusterStart].lat, rows[clusterStart].lon, rows[i].lat, rows[i].lon);
    if (d >= RADIUS_M) {
      // Close old cluster: keep rows[clusterStart] and rows[i-1], delete interior.
      for (let j = clusterStart + 1; j <= i - 2; j++) toDelete.push(rows[j].id);
      clusterStart = i;
    }
  }
  // Close final cluster.
  for (let j = clusterStart + 1; j <= rows.length - 2; j++) toDelete.push(rows[j].id);

  if (toDelete.length === 0) continue;
  totalDeleted += toDelete.length;

  if (DRY_RUN) {
    console.log(`  mmsi=${mmsi} source=${source}: ${rows.length} rows → keep ${rows.length - toDelete.length}, delete ${toDelete.length}`);
  } else {
    for (const id of toDelete) deleteStmt.run(id);
    console.log(`  mmsi=${mmsi} source=${source}: deleted ${toDelete.length} of ${rows.length} rows`);
  }
}

if (DRY_RUN) {
  console.log(`\n[DRY-RUN] Would delete ${totalDeleted} rows.`);
} else {
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM readings WHERE source IN ('sf','mst')`).get().n;
  console.log(`\nDone. Deleted ${totalDeleted} rows. Remaining SF/MST rows: ${remaining}`);
}
