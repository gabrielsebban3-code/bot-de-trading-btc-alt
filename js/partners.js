// Encadré « Plateformes partenaires » des fiches paire et crypto : un bouton par plateforme dont le lien de
// parrainage est rempli dans config.js. Si un visiteur ouvre un compte avec, la plateforme reverse une part
// de ses frais à Dinexo, sans rien lui coûter de plus.
import { PARTNERS } from './config.js';
import { esc, safeUrl } from './format.js';

const LIST = [
  ['okx', 'OKX', 'La plateforme d\'où viennent les prix et les signaux de Dinexo.'],
  ['bitget', 'Bitget', 'Connue pour le copy trading : copier les trades d\'autres traders.'],
  ['binance', 'Binance', 'La plus grande plateforme du monde, avec beaucoup de cryptos.'],
];

export const partners = () => LIST.filter(([id]) => safeUrl(PARTNERS[id])).map(([id, name, pitch]) => ({ id, name, pitch, url: safeUrl(PARTNERS[id]) }));

export function partnersBox() {
  const list = partners();
  if (!list.length) return '';
  return `<div class="box pt-box"><h2>Plateformes partenaires</h2><div class="pt-list">
    ${list.map(p => `<a class="pt" href="${p.url}" target="_blank" rel="sponsored noopener"><b>${esc(p.name)}</b><span>${esc(p.pitch)}</span><span class="pt-go">Créer un compte →</span></a>`).join('')}
  </div><p class="txt muted pt-note">Liens partenaires : si tu ouvres un compte avec, la plateforme reverse une part de ses frais à Dinexo. Ça ne te coûte rien de plus.</p></div>`;
}
