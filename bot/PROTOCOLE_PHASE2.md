# Protocole pré-enregistré de la Phase 2 : C1 et C2 sur BTC et ETH

Écrit le 2026-11-18, avant tout backtest de C1 ou C2. Complète `PROTOCOLE.md` (découpage, coûts, critères).
Les paramètres sont dans `config.yaml` (sections `concepts`, `phase2`, `walk_forward`, `robustness`, `baseline`).

## 1. Périmètre

- Paires : BTCUSDT, ETHUSDT (toutes deux membres de l'univers sur toute la période ; aucune n'est mise de côté).
- Timeframes de signal : 1h, 4h, 1D. Chemin intrabougie des stops : 15m.
- Sens testés séparément : long seul, short seul, long + short.
- Portefeuille simulé : 1 % de risque par trade, une position par paire, perte journalière maximale 3 %.

## 2. Règles communes

- Signal seulement sur bougie close, de volume non nul, hors des 30 jours qui suivent le début de l'historique
  ou un trou de données, quand tous les indicateurs nécessaires existent.
- Timeframe de contexte : 1h → 4h, 4h → 1D, 1D → 1D. Timeframe déclencheur de C2 : 1h → 15m, 4h → 1h, 1D → 4h.
  Une bougie d'un autre timeframe n'est lue que si elle est close au moment de la décision.
- **Régime** (filtre de C1 et de C2) : haussier si, sur la dernière bougie de contexte close, la clôture est
  au-dessus de l'EMA 50 et de l'EMA 200, l'ADX(14) > 20, et le rendement sur 60 jours (bougies journalières
  closes) est positif. Baissier : symétrique. Sinon : aucun signal.
- Entrée au marché à l'ouverture suivante (moteur de la Phase 1, mêmes coûts pour tous).

## 3. C1 : cassure de tendance

- Long : régime haussier et clôture au-dessus du plus haut des N bougies précédentes (timeframe du signal).
  Toute bougie qui clôture au-delà est un signal ; la limite d'une position par paire évite les doublons.
- N ∈ {20, 55, 100, ensemble}. **Ensemble** : pour chaque N de {20, 55, 100}, état +1 après une clôture au-dessus
  du canal, −1 après une clôture en dessous, inchangé sinon ; score = moyenne des trois états (−1 à +1).
  Signal long quand score ≥ 2/3 et clôture au-dessus du canal 20 (cassure fraîche). Short symétrique.
- Stop initial : 2,5 ATR(14) du timeframe du signal, depuis le prix de remplissage.
- Sortie ∈ {chandelier : extrême depuis l'entrée ∓ 3 ATR ; Donchian : plus bas (plus haut) des 20 dernières
  bougies closes}, recalculée à chaque clôture du timeframe du signal, jamais défavorable. Pas d'objectif fixe.
- Filtre volume relatif > 1,2 : testé en **ablation** sur la variante retenue (section 6), pas dans la grille.
- Grille : 3 timeframes × 4 N × 2 sorties × 3 sens = **72 variantes**.

## 4. C2 : repli dans la tendance

- **Repli** (timeframe du signal, régime haussier) : variante `ema20` ou `ema50` = le plus bas de la bougie touche
  ou traverse l'EMA ; variante `structure` = le plus bas entre dans ±0,5 ATR du dernier plus bas de swing confirmé.
  Le repli reste « armé » pendant 5 bougies du timeframe du signal à partir de la clôture de la bougie de repli.
- **Reprise** : sur le timeframe déclencheur, une cassure de structure haussière (BOS ou CHoCH, clôture au-dessus
  du dernier plus haut de swing confirmé) pendant que le repli est armé et que le régime est toujours haussier.
  Un repli donne au plus un signal.
- Stop : dernier plus bas de swing confirmé du timeframe déclencheur − 0,5 ATR(14) de ce timeframe.
- Pivots ∈ {fractal (3 bougies), ZigZag (3 ATR), hiérarchique (niveau intermédiaire)}, utilisés pour la zone,
  la cassure et le stop : c'est la comparaison des trois méthodes de l'Étape 4.
- Sortie : chandelier 3 ATR du timeframe du signal (même logique que C1). Jamais contre le régime.
- Grille : 3 timeframes × 3 replis × 3 méthodes de pivots × 3 sens = **81 variantes**.

## 5. Walk-forward (validation)

- Fenêtres de test de 6 mois de 2022-01-01 à 2026-10-31 (10 fenêtres, la dernière de 4 mois) ; réglage sur les
  24 mois qui précèdent chaque fenêtre.
- Groupe = concept × timeframe × sens (C1 : 8 variantes par groupe ; C2 : 9). Dans chaque fenêtre, la variante
  retenue est celle qui a la meilleure espérance en R sur le réglage parmi celles qui ont au moins 10 trades ;
  si aucune n'en a 10, le groupe ne trade pas dans la fenêtre.
- La variante retenue est simulée sur la fenêtre de test, le capital passant d'une fenêtre à la suivante.
  Les métriques du groupe sont celles de ces trades hors échantillon concaténés.

## 6. Contrôles par groupe (critères de `PROTOCOLE.md`)

1. ≥ 100 trades hors échantillon ; 2. borne basse de l'IC 95 % de l'espérance > 0 ; 3. test SPA (toutes les
   variantes de la Phase 2, rendements journaliers 2022-01 → 2026-10, référence = rester à plat) p < 0,05 ;
4. Deflated Sharpe > 0,95 avec 232 essais hérités + toutes les variantes testées ; 5. au-dessus du 95e centile
   d'entrées aléatoires (même paire, même fenêtre, même sens autorisé, même distance de stop en ATR, même sortie,
   mêmes coûts) ; 6. espérance > 0 avec coûts × 1,5 ; 7. ≥ 75 % de voisines positives (variante la plus souvent
   retenue, chaque paramètre numérique décalé de ±20 %, simulée sur 2022-01 → 2026-10) ; 8. ≥ 60 % des années
   positives et aucune année > 50 % du total de R.
- Critères 9 (paires mises de côté) et 10 (test final) : en Phase 3 et à la fin. **Aucun verdict « edge confirmé »
  ne peut sortir de la Phase 2.** Un groupe qui passe 1 à 8 est « candidat » pour la Phase 3 ; sinon « pas d'edge »
  (espérance hors échantillon ≤ 0 ou IC nettement négatif) ou « non concluant » (moins de 100 trades ou IC qui
  contient 0 avec espérance positive).
- Ablation du filtre volume sur chaque groupe C1 : même walk-forward avec le filtre ; il n'est gardé que s'il
  améliore l'espérance hors échantillon (9 essais de plus).
- Rapports aussi : par paire, par année et trimestre, par régime (tendance / range / forte volatilité),
  par type de sortie, part des coûts, comparaison au buy-and-hold BTC et au panier BTC + ETH.

## 7. Compteur d'essais

72 (C1) + 81 (C2) + 9 (ablation) = **162 essais**, soit **394** avec les 232 hérités.

## 8. Ce qui est interdit après le premier calcul

Changer une valeur de la grille, une règle de signal, la règle de sélection ou un seuil. Toute correction de bug
est datée dans `DECISIONS.md`, le calcul complet est relancé, et l'essai est compté une seconde fois.
