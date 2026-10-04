// Page Premium (#premium) : ce que donnent le compte gratuit et l'abonnement Premium.
// Les boutons changent selon la personne (visiteur, membre, Premium) grâce aux classes posées sur body.
import { ALERTS, HISTORY_DAYS, PRICE } from './premium.js';

const SOON = '<span class="tag mid">bientôt</span>';
const li = (text, soon = false) => `<li><span class="pk" aria-hidden="true">✓</span><span>${text}${soon ? ` ${SOON}` : ''}</span></li>`;

const FREE = [
  ['Résumé, Marché, Actu, Heatmap et fiches crypto, en entier'],
  ['Setups en direct sur <b>BTC et ETH</b>, les autres paires avec 24 heures de retard'],
  [`Fiches trade complètes et historique sur <b>${Math.round(HISTORY_DAYS.free / 30)} mois</b>`],
  ['Tous les outils de calcul'],
  [`Alertes de prix, jusqu'à <b>${ALERTS.free}</b>`],
  ['Bilan de portefeuille, jusqu\'à 10 cryptos', true],
  ['La moitié de l\'e-learning : toutes les leçons débutant', true],
  ['Le Discord public, avec le résumé du matin'],
];
const PREMIUM = [
  ['Tout ce qu\'il y a dans le gratuit'],
  ['Setups en direct sur <b>toutes les paires</b> (SOL et pétrole compris)'],
  ['Historique et bilan des setups sur <b>12 mois</b>'],
  [`Jusqu'à <b>${ALERTS.premium}</b> alertes de prix`],
  ['Alertes sur Discord, même quand le site est fermé', true],
  ['Bilan de portefeuille illimité, avec un rapport chaque semaine', true],
  ['E-learning complet, avec les leçons avancées', true],
  ['Calculateur d\'impôts crypto', true],
  ['Journal de trading avec statistiques', true],
  ['Salon Discord réservé aux membres, avec le bilan du dimanche', true],
];

export function renderPlans() {
  document.getElementById('premium-plans').innerHTML = `
    <div class="plans">
      <div class="box plan">
        <h2>Gratuit <span class="muted">avec un compte</span></h2>
        <p class="price"><b>0 €</b></p>
        <ul class="plan-list">${FREE.map(([t, s]) => li(t, s)).join('')}</ul>
        <div class="links guest-only"><a class="btn" href="#compte/connexion">Créer mon compte gratuit</a></div>
        <p class="txt muted members-only free-only">C'est ta formule actuelle.</p>
      </div>
      <div class="box plan best">
        <h2>Premium <span class="ptag">✦</span></h2>
        <p class="price"><b>${PRICE}</b> <span class="muted">par mois</span></p>
        <ul class="plan-list">${PREMIUM.map(([t, s]) => li(t, s)).join('')}</ul>
        <div class="free-only">
          <div class="links"><button type="button" class="btn primary" disabled>Paiement bientôt disponible</button></div>
          <p class="txt muted">Le paiement en ligne n'est pas encore ouvert. Tu veux faire partie des premiers ? Dis-le sur le Discord.</p>
        </div>
        <p class="txt premium-only"><b class="up">Tu es Premium.</b> Merci pour ton soutien !</p>
      </div>
    </div>
    <p class="fine">« Bientôt » : ces fonctions sont en préparation.</p>`;
}
