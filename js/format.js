// Mise en forme des nombres et des textes (français).

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// N'accepte que les liens http(s) venant des API (évite les liens « javascript: »).
export const safeUrl = u => (/^https?:\/\//i.test(String(u ?? '')) ? esc(u) : null);

export const fmt = (n, d = 0) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

export function money(n) {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${fmt(n / 1e9, 2)} Md$`;
  if (a >= 1e6) return `${fmt(n / 1e6, a >= 1e8 ? 0 : 1)} M$`;
  if (a >= 1e3) return `${fmt(n / 1e3, 0)} k$`;
  return `${fmt(n, 0)} $`;
}

export function price(n) {
  if (n === null || n === undefined) return '—';
  return fmt(n, n >= 1000 ? 0 : n >= 1 ? 2 : 4);
}

// Variation en % colorée. `ratio` = true quand la valeur est une fraction (0,12 = +12 %).
export function pct(n, ratio = true) {
  if (n === null || n === undefined) return '<span class="muted">—</span>';
  const v = ratio ? n * 100 : n;
  const shown = Math.abs(v) >= 1000 ? `${fmt(v / 100, 0)}×` : `${fmt(v, Math.abs(v) < 10 ? 1 : 0)} %`;
  return `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${shown}</span>`;
}

export function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} jours`;
}

export const date = iso => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
