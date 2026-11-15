# Protocole de l'étude 2 : suivi de tendance 4h, test final unique

Rédigé le 2026-11-15, **avant** tout calcul de l'étude 2 et avant toute lecture du jeu TEST.
Ce document est figé dès sa validation par Gabriel. Rien n'y est modifié ensuite.

## 1. Pourquoi une étude 2

L'étude 1 (100 configurations, voir `REPORT.md`) n'a validé aucun setup. Une seule configuration a rempli
8 critères sur 9 sur VAL : `C_tf4h_dc55_volon`. Elle a échoué sur le drawdown (33,4 % pour un maximum de 25 %)
avec un risque de 1 % du capital par trade.

L'étude 2 pose une seule question : **cette même configuration, avec un risque de 0,5 % par trade, remplit-elle
les 9 critères sur des données jamais vues (2025-01-01 → 2026-10-31) ?**

## 2. Ce qui est testé

Une seule configuration, règles identiques à l'étude 1 :

- Graphique 4h, bougies closes uniquement.
- Signal : clôture au-dessus du plus haut des 55 bougies précédentes (achat) ou sous leur plus bas (vente).
- Filtre : volume de la bougie de cassure > 1,5 × la moyenne des 20 bougies précédentes.
- Entrée au marché à l'ouverture de la bougie suivante.
- Stop initial à 2 × ATR(14). Signal ignoré si le stop est à moins de 0,3 % ou à plus de 6 % du prix d'entrée.
- Sortie : stop suiveur chandelier à 3 × ATR(14), jamais reculé.
- Une position par paire, 5 au total, levier maximal 5.

Mêmes 20 paires (`config/pairs.json`), mêmes données, même moteur, mêmes coûts (frais 0,02 % / 0,05 %,
slippage 0,03 %, funding réel), même baseline aléatoire.

## 3. La seule différence avec l'étude 1

**Risque par trade : 0,5 % du capital au lieu de 1 %.**

Ce changement est décidé après avoir vu les résultats DEV et VAL de l'étude 1. Il ne change pas l'espérance
en R ; il divise à peu près par deux le drawdown **et** le rendement. C'est pour cette raison qu'il doit être
confirmé sur des données neuves et qu'il ne peut pas être présenté comme une validation de l'étude 1.

## 4. Critères (inchangés)

Les 9 critères de la section 9 de la mission, avec les mêmes seuils :
≥ 100 trades ; espérance ≥ +0,10 R et PF ≥ 1,15 ; borne basse de l'IC 95 % > 0 ; espérance > 0 avec coûts ×2 ;
au-dessus du 95e centile de la baseline aléatoire ; espérance > 0 sans la meilleure paire ; ≥ 60 % des paires
(≥ 10 trades) positives ; drawdown ≤ 25 % ; au plus 1 trimestre sur 3 sous −0,3 R.

## 5. Déroulement

1. Relancer DEV et VAL avec un risque de 0,5 %. Si la configuration ne remplit pas les 9 critères sur VAL :
   arrêt, le TEST n'est pas ouvert, verdict REJETÉ.
2. Sinon, ouvrir le TEST **une seule fois** sur cette configuration.
3. Verdict : **RETENU** si les 9 critères sont remplis sur TEST, **REJETÉ** sinon (INSUFFISANT sous 100 trades).
4. RETENU : construction du scanner d'alertes Discord (section 12 bis de la mission).
   REJETÉ : « Aucun setup validé, scanner non construit », fin du projet sur ces données.

## 6. Ce qui est interdit

- Relancer le TEST, sur cette configuration ou sur une autre : le jeu TEST ne sert qu'une fois.
- Changer une règle, un seuil ou le risque après avoir vu le résultat du TEST.
- Tester d'autres variantes « jusqu'à ce que ça passe ».

## 7. Réserves connues avant de commencer

- La configuration est la meilleure de 100 sur VAL : son résultat VAL est donc probablement surestimé
  (biais du gagnant). Il faut s'attendre à moins bien sur TEST. Un échec est une issue probable.
- Les paires ont été choisies sur leur volume de 2026 (biais de survie, déjà noté dans `REPORT.md`).
- Du jeu TEST, seuls ont été vus : l'en-tête et 2 bougies BTC d'octobre 2026 (`DECISIONS.md`, D4), et les prix
  d'exécution BTC d'août à novembre 2026 figurant dans l'historique de compte de Gabriel. Sans effet sur les
  règles, qui étaient fixées avant.
- Un verdict RETENU prouve que la méthode a passé un test strict sur le passé. Il ne garantit aucun gain futur.
- Les résultats sont calculés sur les contrats Binance USDT-M. Sur une autre plateforme, les paires
  disponibles, les frais et le funding peuvent différer.
