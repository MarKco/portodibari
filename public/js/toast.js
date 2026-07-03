import { el } from './dom.js';
import { escHtml } from './helpers.js';

let toastTimer = null;

export function showAlert(title, bodyHtml = '', duration = 5000) {
  el.toastTitle.textContent = title;
  el.toastBody.innerHTML = bodyHtml;
  el.toastEl.classList.remove('hidden', 'toast-hiding');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toastEl.classList.add('toast-hiding');
    setTimeout(() => el.toastEl.classList.add('hidden'), 420);
  }, duration);
}

/**
 * Bottom undo toast with a live countdown and an "Annulla" button. Purely
 * visual — the caller owns the real timer that commits the action. Returns
 * `{ cancel }` to dismiss the toast (e.g. when the action is committed early).
 *
 *   showUndoToast({ message, seconds, onUndo })
 */
export function showUndoToast({ message, seconds = 10, onUndo }) {
  let remaining = seconds;
  el.undoToastMsg.textContent = message;
  el.undoToastCount.textContent = String(remaining);
  el.undoToast.classList.remove('hidden', 'toast-hiding');

  let interval = null;
  const cancel = () => {
    clearInterval(interval);
    interval = null;
    el.undoToast.classList.add('toast-hiding');
    setTimeout(() => el.undoToast.classList.add('hidden'), 420);
    el.undoToastBtn.onclick = null;
  };

  interval = setInterval(() => {
    remaining -= 1;
    el.undoToastCount.textContent = String(Math.max(0, remaining));
    if (remaining <= 0) clearInterval(interval);
  }, 1000);

  el.undoToastBtn.onclick = () => {
    cancel();
    if (onUndo) onUndo();
  };

  return { cancel };
}

export function showToast(name, bbox) {
  const [[swLat, swLon], [neLat, neLon]] = bbox;
  const geojson = JSON.stringify({
    type: 'Polygon',
    coordinates: [[[swLon, swLat], [neLon, swLat], [neLon, neLat], [swLon, neLat], [swLon, swLat]]],
  });
  showAlert(
    `📍 Area: ${name}`,
    `SW&nbsp;&nbsp;${swLat.toFixed(4)}°N, ${swLon.toFixed(4)}°E<br>` +
      `NE&nbsp;&nbsp;${neLat.toFixed(4)}°N, ${neLon.toFixed(4)}°E<br>` +
      `<span class="toast-geojson">${escHtml(geojson)}</span>`
  );
}
