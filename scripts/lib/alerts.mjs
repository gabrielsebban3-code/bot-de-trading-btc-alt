// Alertes Discord : un message épuré par nouveau setup confirmé et par nouvelle news critique.
// Le nouveau fichier de données est comparé à la version déjà en ligne : seul ce qui vient d'apparaître est envoyé.

export const ALERTS = {
  setupMaxAgeMs: 24 * 3600e3, // un setup plus vieux n'est plus actionnable
  newsMaxAgeMs: 6 * 3600e3, // même fenêtre que le bandeau rouge du site
  maxPerRun: 5, // garde-fou : jamais plus de 5 messages d'un coup
};
const GREEN = 0x22c55e;
const RED = 0xef4444;
const ORANGE = 0xf97316;
const NFA = 'Pas un conseil financier.';

const num = v => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const digits = a >= 1000 ? 0 : a >= 1 ? 2 : 4;
  return v.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: a >= 1000 ? 0 : Math.min(digits, 2) })
    .replace(/ | /g, ' ');
};

const isAlertSetup = (s, now) => s.status === 'confirmé' && s.outcome === 'open' && now - s.time <= ALERTS.setupMaxAgeMs;
const isAlertNews = (n, now) => n.importance === 'critical' && now - n.time <= ALERTS.newsMaxAgeMs;

// Nouveaux setups et news à envoyer. Sans version précédente (premier passage), rien n'est envoyé : pas d'avalanche.
export function pickAlerts({ setups, news, prevSetups, prevNews, now = Date.now() }) {
  const out = [];
  if (setups && prevSetups) {
    const seen = new Set((prevSetups.live || []).filter(s => s.status === 'confirmé').map(s => s.id));
    for (const s of setups.live || []) if (isAlertSetup(s, now) && !seen.has(s.id)) out.push({ kind: 'setup', item: s, detector: setups.detectors?.[s.detector] });
  }
  if (news && prevNews) {
    // Une news critique regroupe parfois plusieurs articles : déjà envoyée si l'un de ses articles l'était.
    const seen = new Set((prevNews.items || []).filter(n => n.importance === 'critical').flatMap(n => n.ids || [n.id]));
    for (const n of news.items || []) if (isAlertNews(n, now) && !(n.ids || [n.id]).some(id => seen.has(id))) out.push({ kind: 'news', item: n });
  }
  return out.sort((a, b) => a.item.time - b.item.time).slice(-ALERTS.maxPerRun);
}

// Message Discord (un « embed ») : bordure verte pour un long, rouge pour un short, orange pour une news.
export function toDiscord(alert, siteUrl = '') {
  const site = siteUrl.replace(/\/?$/, '/');
  if (alert.kind === 'setup') {
    const s = alert.item;
    const long = s.dir === 'long';
    return {
      title: `${s.symbol} · ${long ? 'Long' : 'Short'}${alert.detector ? ` · ${alert.detector}` : ''}`,
      url: siteUrl ? `${site}#setup/${encodeURIComponent(s.id)}` : undefined,
      color: long ? GREEN : RED,
      description: s.why || undefined,
      fields: [
        { name: 'Entrée', value: num(s.entry), inline: true },
        { name: 'Stop', value: num(s.sl), inline: true },
        { name: 'R:R', value: `1:${String(Math.round(s.rr * 10) / 10).replace('.', ',')}`, inline: true },
        { name: 'Objectifs', value: (s.tp || []).map(num).join(' · ') || '—', inline: false },
      ],
      footer: { text: `Bougie 4h confirmée · ${NFA}` },
      timestamp: new Date(s.time).toISOString(),
    };
  }
  const n = alert.item;
  const impacts = (n.impacts || []).map(([a, d]) => `${a} ${d > 0 ? '▲' : d < 0 ? '▼' : ''}`.trim()).join(' · ');
  return {
    title: `Critique · ${n.title}`.slice(0, 256),
    url: n.link || undefined,
    color: ORANGE,
    description: [n.why, impacts && `Impact probable : ${impacts}`].filter(Boolean).join('\n') || undefined,
    footer: { text: `${(n.sources || [n.source]).filter(Boolean).join(', ')} · ${NFA}` },
    timestamp: new Date(n.time).toISOString(),
  };
}
