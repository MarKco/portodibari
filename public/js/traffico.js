import { S } from './store.js';
import { api } from './api.js';
import { showView } from './views.js';
import { t } from './i18n.js';
import {
  escHtml,
  formatTime,
  formatDuration,
  shipTypeBadge,
  riskBadge,
  cargoClassLabel,
  cargoClassHelpText,
  infoIcon,
} from './helpers.js';

export async function loadTraffco() {
  try {
    const area = encodeURIComponent(S.currentPreset || '');
    const aq = area ? `area=${area}` : '';
    const [statsData, eventsData, expectedData, scoreData] = await Promise.all([
      api(`/api/stats${aq ? `?${aq}` : ''}`).catch(() => null),
      api(`/api/events?limit=50${aq ? `&${aq}` : ''}`).catch(() => null),
      api(`/api/ships/expected${aq ? `?${aq}` : ''}`).catch(() => null),
      api(`/api/stats/scores${aq ? `?${aq}` : ''}`).catch(() => null),
    ]);
    renderStats(statsData);
    renderPortEventsTable(eventsData?.rows || []);
    renderExpectedTable(expectedData?.ships || [], expectedData?.keyword);
    renderBandChart(scoreData?.byBand, scoreData?.total);
    renderCargoChart(scoreData?.byCargo);
    renderLoadChart(scoreData?.byLoad);
    renderFactorsChart(scoreData?.byFactor);
    renderDailyChart(scoreData?.dailyArrivals);
    renderTopShips(scoreData?.topShips);
  } catch {
    /* ignore */
  }
}

function renderStats(stats) {
  const elc = document.getElementById('stats-cards');
  if (!stats) {
    elc.innerHTML = '';
    return;
  }
  const avgStay =
    stats.avgStayHours != null ? formatDuration(Math.round(stats.avgStayHours * 3600 * 1000)) : '—';
  elc.innerHTML = `
    <div class="stat-card"><div class="stat-val">${stats.arrivalsToday}</div><div class="stat-label">${t('stats.today')}</div></div>
    <div class="stat-card"><div class="stat-val">${stats.arrivalsWeek}</div><div class="stat-label">${t('stats.week')}</div></div>
    <div class="stat-card"><div class="stat-val">${stats.totalArrivals}</div><div class="stat-label">${t('stats.total')}</div></div>
    <div class="stat-card"><div class="stat-val">${avgStay}</div><div class="stat-label">${t('stats.avgStay')}</div></div>
  `;
  renderHourlyChart(stats.byHour);
  renderTypeChart(stats.byType);
}

function renderHourlyChart(byHour) {
  const elc = document.getElementById('chart-hourly');
  const hours = Array.from({ length: 24 }, (_, i) => ({ hour: String(i).padStart(2, '0'), n: 0 }));
  (byHour || []).forEach((r) => {
    const h = hours.find((x) => x.hour === r.hour);
    if (h) h.n = r.n;
  });
  const max = Math.max(...hours.map((h) => h.n), 1);
  elc.innerHTML = `<div class="hourly-bars">${hours
    .map(
      (h) => `
    <div class="hour-bar-wrap" title="${t('chart.hourly', { hour: h.hour, n: h.n })}">
      <div class="hour-bar" style="height:${Math.max(2, Math.round((h.n / max) * 100))}%"></div>
      <div class="hour-label">${h.hour}</div>
    </div>`
    )
    .join('')}</div>`;
}

function renderTypeChart(byType) {
  const elc = document.getElementById('chart-type');
  if (!byType?.length) {
    elc.innerHTML = `<p class="empty">${t('empty.typeData')}</p>`;
    return;
  }
  const total = byType.reduce((s, r) => s + r.n, 0);
  elc.innerHTML = byType
    .map(
      (r) => `
    <div class="type-bar-row">
      <div class="type-bar-label">${shipTypeBadge(r.ship_type)}</div>
      <div class="type-bar-track"><div class="type-bar-fill" style="width:${Math.round((r.n / total) * 100)}%"></div></div>
      <div class="type-bar-count">${r.n}</div>
    </div>`
    )
    .join('');
}

// Arrivals broken down by cargo class (what the ships are built to carry).
// Each row carries an "ⓘ" explaining the class, since labels like
// "Tanker (generico)" or "Ro-Ro merci" aren't self-evident.
function renderCargoChart(byCargo) {
  const elc = document.getElementById('chart-cargo');
  if (!elc) return;
  if (!byCargo?.length) {
    elc.innerHTML = `<p class="empty">${t('empty.cargoData')}</p>`;
    return;
  }
  const total = byCargo.reduce((s, r) => s + r.count, 0);
  elc.innerHTML = byCargo
    .map((r) => {
      const label = cargoClassLabel(r.cls);
      return `
    <div class="type-bar-row">
      <div class="type-bar-label">${escHtml(label)}${infoIcon(label, cargoClassHelpText(r.cls))}</div>
      <div class="type-bar-track"><div class="type-bar-fill" style="width:${Math.round((r.count / total) * 100)}%"></div></div>
      <div class="type-bar-count">${r.count}</div>
    </div>`;
    })
    .join('');
}

// Estimated load condition (laden / partial / in ballast) across present ships —
// an indicative AIS-draught proxy for "are arrivals coming in full or empty".
function renderLoadChart(byLoad) {
  const elc = document.getElementById('chart-cargo-load');
  if (!elc) return;
  const total = (byLoad || []).reduce((s, r) => s + r.count, 0);
  if (!total) {
    elc.innerHTML = `<p class="empty">${t('empty.loadData')}</p>`;
    return;
  }
  elc.innerHTML = `<div class="band-tiles">${byLoad
    .map((r) => {
      const pct = Math.round((r.count / total) * 100);
      return `<div class="band-tile load-${r.state}">
        <div class="band-tile-count">${r.count}</div>
        <div class="band-tile-label">${t('load.' + r.state)}</div>
        <div class="band-tile-pct">${pct}%</div>
      </div>`;
    })
    .join('')}</div><div class="band-total">${t('load.estimatedNote')}</div>`;
}

function renderPortEventsTable(rows) {
  const tbody = document.getElementById('events-body');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">${t('empty.events')}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (e) => `
    <tr>
      <td><span class="event-badge ${e.event_type}">${e.event_type === 'arrived' ? t('event.arrived') : t('event.departed')}</span></td>
      <td class="ship-name">${escHtml(e.ship_name) || '—'}</td>
      <td>${shipTypeBadge(e.ship_type)}</td>
      <td>${formatTime(e.ts)}</td>
    </tr>`
    )
    .join('');
}

function renderBandChart(byBand, total) {
  const el = document.getElementById('chart-band');
  if (!byBand || !total) {
    el.innerHTML = `<p class="empty">${t('empty.riskData')}</p>`;
    return;
  }
  const bands = [
    { key: 'low', labelKey: 'risk.low', range: '0–30',   cls: 'risk-low' },
    { key: 'med', labelKey: 'risk.med', range: '31–70',  cls: 'risk-med' },
    { key: 'high',labelKey: 'risk.high',range: '71–100', cls: 'risk-high' },
  ];
  el.innerHTML = `<div class="band-tiles">${bands
    .map((b) => {
      const n = byBand[b.key] || 0;
      const pct = Math.round((n / total) * 100);
      return `<div class="band-tile ${b.cls}">
        <div class="band-tile-count">${n}</div>
        <div class="band-tile-label">${t(b.labelKey)}</div>
        <div class="band-tile-range">${b.range}</div>
        <div class="band-tile-pct">${pct}%</div>
      </div>`;
    })
    .join('')}</div><div class="band-total">${t('risk.total', { n: total })}</div>`;
}

function renderFactorsChart(byFactor) {
  const el = document.getElementById('chart-factors');
  if (!byFactor?.length) {
    el.innerHTML = `<p class="empty">${t('empty.factors')}</p>`;
    return;
  }
  const max = byFactor[0].count;
  el.innerHTML = byFactor
    .map(
      (f) => `
    <div class="type-bar-row">
      <div class="type-bar-label factor-label" title="${escHtml(f.label)}">${escHtml(f.label)}</div>
      <div class="type-bar-track"><div class="type-bar-fill factor-fill" style="width:${Math.round((f.count / max) * 100)}%"></div></div>
      <div class="type-bar-count">${f.count}</div>
    </div>`
    )
    .join('');
}

function renderDailyChart(dailyArrivals) {
  const el = document.getElementById('chart-daily');
  if (!dailyArrivals?.length) {
    el.innerHTML = `<p class="empty">${t('empty.daily')}</p>`;
    return;
  }
  const days = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, n: 0, label: key.slice(5).replace('-', '/') });
  }
  dailyArrivals.forEach((r) => {
    const slot = days.find((d) => d.day === r.day);
    if (slot) slot.n = r.n;
  });
  const max = Math.max(...days.map((d) => d.n), 1);
  el.innerHTML = `<div class="daily-bars">${days
    .map((d, i) => {
      const showLabel = i % 5 === 0 || i === 29;
      return `<div class="hour-bar-wrap" title="${t('chart.daily', { date: d.day, n: d.n })}">
        <div class="hour-bar daily-bar" style="height:${Math.max(2, Math.round((d.n / max) * 100))}%"></div>
        <div class="hour-label">${showLabel ? d.label : ''}</div>
      </div>`;
    })
    .join('')}</div>`;
}

function renderTopShips(topShips) {
  const el = document.getElementById('chart-top-ships');
  if (!topShips?.length) {
    el.innerHTML = `<p class="empty">${t('empty.topShips')}</p>`;
    return;
  }
  el.innerHTML = `<table>
    <thead><tr>
      <th>${t('traffico.col.name')}</th>
      <th>${t('traffico.col.mmsi')}</th>
      <th class="col-risk">${t('traffico.col.score')}</th>
    </tr></thead>
    <tbody>${topShips
      .map(
        (s) => `
      <tr class="ship-row" data-mmsi="${s.mmsi}">
        <td class="ship-name">${escHtml(s.ship_name) || '—'}</td>
        <td class="mono">${s.mmsi}</td>
        <td class="col-risk">${riskBadge({ score: s.score, band: s.band, factors: [], sources: {} })}</td>
      </tr>`
      )
      .join('')}
    </tbody>
  </table>`;
  el.querySelectorAll('.ship-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      S.detailFrom = 'traffico';
      showView('detail', Number(tr.dataset.mmsi), null);
    });
  });
}

function renderExpectedTable(ships, keyword) {
  const kw = document.getElementById('expected-keyword');
  kw.textContent = keyword ? t('expected.keyword', { kw: keyword }) : '';
  const tbody = document.getElementById('expected-body');
  if (!ships.length) {
    tbody.innerHTML =
      `<tr><td colspan="4" class="empty">${t('empty.expected')}</td></tr>`;
    return;
  }
  tbody.innerHTML = ships
    .map(
      (s) => `
    <tr class="ship-row" data-mmsi="${s.mmsi}">
      <td class="ship-name">${escHtml(s.ship_name) || '—'}</td>
      <td class="mono">${s.mmsi}</td>
      <td class="destination">${escHtml(s.destination) || '—'}</td>
      <td>${formatTime(s.last_seen_at)}</td>
    </tr>`
    )
    .join('');
  tbody.querySelectorAll('.ship-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      S.detailFrom = 'traffico';
      showView('detail', Number(tr.dataset.mmsi), null);
    });
  });
}
