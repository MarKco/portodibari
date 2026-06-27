'use strict';

// The SQLite databases used to live at the project root (ais_data.db,
// heatmap_data.db). They now live under data/db/ to keep the root tidy. To make an
// in-place upgrade seamless, relocateDbFile() moves an existing old-location file
// (and its WAL/-shm sidecars) into the new location the first time the new version
// starts — before the DB is opened. It's a no-op once already migrated, or when
// there's nothing at the old path (fresh install / deploy restore).
//
// NOTE: backup bundles store DB *content*, not file paths, so export/import
// between an old-layout and a new-layout version already works regardless of where
// the files sit — this only adjusts the on-disk file location for an upgrade.

const fs = require('fs');
const path = require('path');

const SIDE = ['', '-wal', '-shm'];

/** Move oldPath (+ -wal/-shm) → newPath if newPath is absent and oldPath exists.
 *  Always ensures the new directory exists. Returns true if a move happened. */
function relocateDbFile(oldPath, newPath) {
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  if (fs.existsSync(newPath) || !fs.existsSync(oldPath)) return false;
  let moved = false;
  for (const suf of SIDE) {
    const from = oldPath + suf;
    const to = newPath + suf;
    try {
      if (fs.existsSync(from)) {
        fs.renameSync(from, to); // same filesystem (project dir) → atomic, cheap
        moved = true;
      }
    } catch {
      // Cross-device or locked sidecar: fall back to copy. The main file is what
      // matters; a stale -wal/-shm is rebuilt by SQLite on open.
      try { fs.copyFileSync(from, to); fs.unlinkSync(from); moved = true; } catch { /* skip sidecar */ }
    }
  }
  if (moved) console.log(`[DB] Database spostato in ${path.dirname(newPath)}/ (${path.basename(newPath)})`);
  return moved;
}

module.exports = { relocateDbFile };
