'use strict';

const { fetchHttp, parseShipHtml } = require('./http');

/**
 * Scrape a VesselFinder details page. `identifier` is an IMO or MMSI number
 * coming from our own DB; it is encoded defensively to keep it in the path.
 */
async function crawlVesselFinder(identifier) {
  const html = await fetchHttp(
    `https://www.vesselfinder.com/vessels/details/${encodeURIComponent(identifier)}`
  );
  return parseShipHtml(html);
}

module.exports = { crawlVesselFinder };
