// Account widget: shows who's logged in, a logout control, an admin link, and —
// while an admin impersonates a user — a top banner with a one-click exit.
// Self-contained (its own DOM + styles); does not touch the rest of the SPA.

import { getLang } from './i18n.js';

// Manual links default to the Italian version (index.html); point them at the
// English one when that's the active UI language, so the sidebar always opens
// the guide in the user's language.
function setManualLinksLang() {
  if (getLang() !== 'en') return;
  const manual = document.getElementById('link-manual');
  const manualAdmin = document.getElementById('link-manual-admin');
  if (manual) manual.href = '/manuale/index.en.html';
  if (manualAdmin) manualAdmin.href = '/manuale_admin/index.en.html';
}
setManualLinksLang();

async function init() {
  let me;
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) return; // not logged in → the gate/api wrapper handles redirect
    me = await r.json();
  } catch {
    return;
  }

  const css = document.createElement('style');
  css.textContent = `
    #acct { position:fixed; top:8px; right:10px; z-index:1200; display:flex; align-items:center; gap:.5rem;
            background:var(--surface-2,rgba(20,26,36,.92)); border:1px solid var(--border-strong,#2a3441);
            border-radius:9px; padding:.3rem .55rem;
            font:12px/1.2 system-ui,sans-serif; color:var(--text,#e6edf5); box-shadow:var(--shadow-md,0 4px 16px rgba(0,0,0,.3)); }
    #acct .who { color:var(--text-muted,#9aa7b5); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #acct a, #acct button { color:var(--accent-text,#93c5fd); background:none; border:0; cursor:pointer; font:inherit; padding:.15rem .25rem; }
    #acct a:hover, #acct button:hover { text-decoration:underline; }
    #imp-banner { position:fixed; top:0; left:0; right:0; z-index:1300; background:#b45309; color:#fff;
                  text-align:center; padding:.35rem .5rem; font:600 12px/1.3 system-ui,sans-serif; }
    #imp-banner button { margin-left:.6rem; background:#fff; color:#7c2d12; border:0; border-radius:6px;
                         padding:.15rem .5rem; cursor:pointer; font:inherit; }
    body.impersonating { padding-top:26px; }
    #tester-banner { position:fixed; top:0; left:0; right:0; z-index:1290; background:#6b21a8; color:#e9d5ff;
                     text-align:center; padding:.35rem .5rem; font:600 12px/1.3 system-ui,sans-serif; }
    body.tester-account { padding-top:26px; }
  `;
  document.head.appendChild(css);

  const name = me.user.first_name ? `${me.user.first_name} ${me.user.last_name || ''}`.trim() : (me.user.username || me.user.email);

  const box = document.createElement('div');
  box.id = 'acct';
  box.innerHTML =
    `<span class="who" title="${esc(me.user.email)}">${esc(name)}</span>` +
    (me.isAdmin ? `<a href="/admin" title="Amministrazione">Admin</a>` : '') +
    `<button id="acct-logout" title="Esci">Esci</button>`;
  document.body.appendChild(box);

  document.getElementById('acct-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  // Non-admins: hide the admin-only settings tabs and the global setting rows
  // (the server enforces this too — this just keeps the UI honest).
  if (!me.isAdmin) hideAdminControls();

  // Admins additionally get the admin-manual link in the sidebar (above the
  // user-manual link, which stays visible for everyone).
  if (me.isAdmin) document.getElementById('link-manual-admin')?.style.setProperty('display', '');

  // "Attività di gruppo" only makes sense for users bound to a group.
  if (me.inGroup) document.getElementById('btn-group-activity')?.style.setProperty('display', '');

  if (me.isImpersonating) {
    document.body.classList.add('impersonating');
    const banner = document.createElement('div');
    banner.id = 'imp-banner';
    banner.innerHTML = `Stai impersonando <strong>${esc(me.user.email)}</strong> (sola lettura) <button id="imp-stop">Esci impersonificazione</button>`;
    document.body.appendChild(banner);
    document.getElementById('imp-stop').addEventListener('click', async () => {
      await fetch('/api/admin/impersonate/stop', { method: 'POST' });
      window.location.reload();
    });
  }

  if (me.testerLimits) {
    document.body.classList.add('tester-account');
    const tb = document.createElement('div');
    tb.id = 'tester-banner';
    tb.textContent = `Account tester — max ${me.testerLimits.maxAreas} aree (≤ ${me.testerLimits.maxAreaKm2} km²), max ${me.testerLimits.maxFollows} navi seguite`;
    document.body.appendChild(tb);
  }
}

// Admin-only settings UI: whole tabs + the global toggles in the General tab.
function hideAdminControls() {
  const tabs = ['params', 'backup', 'log', 'logs', 'health'];
  for (const t of tabs) document.getElementById(`settings-tab-${t}`)?.style.setProperty('display', 'none');
  const adminRows = ['setting-risk-weights', 'setting-cargo-weights'];
  for (const id of adminRows) document.getElementById(id)?.style.setProperty('display', 'none');
  const adminToggles = [
    'toggle-import-vf', 'toggle-import-mt', 'toggle-import-equasis', 'toggle-import-gfw',
    'toggle-import-sanctions', 'toggle-import-sanctions-extra', 'toggle-import-psc',
    'toggle-exclude-tankers', 'toggle-check-spoofing', 'toggle-check-dark', 'toggle-app-log',
  ];
  for (const id of adminToggles) {
    const row = document.getElementById(id)?.closest('.setting-row');
    if (row) row.style.display = 'none';
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

init();
