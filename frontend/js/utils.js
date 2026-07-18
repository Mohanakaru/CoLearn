/* ── Utility helpers ─────────────────────────────────────────── */

/** Show an alert banner inside an element */
function showAlert(el, type, html) {
  el.className = type === 'success' ? 'alert-success' : 'alert-error';
  el.innerHTML = html;
}

/** Show an error that auto-hides after `ms` milliseconds */
function showTempError(el, msg, ms) {
  showAlert(el, 'error', msg);
  setTimeout(() => { el.className = 'hidden'; el.innerHTML = ''; }, ms);
}

/** Show a toast notification */
function showToast(id, text, type) {
  const el    = document.getElementById(id);
  const inner = el ? el.querySelector('.toast-inner') : null;
  if (!el) return;
  if (inner && text) inner.innerHTML = text;
  if (inner && type) { inner.className = 'toast-inner'; if (type !== 'dark') inner.classList.add(type); }
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2800);
}

/** Open / close modal overlay */
function openModal(id)  { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

/** Escape HTML to prevent XSS */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Copy text to clipboard */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}
