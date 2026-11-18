# Protocole pré-enregistré de la Phase 3 : tournoi complet sur l'univers

Écrit le 2026-11-18, avant tout calcul de la Phase 3. Complète `PROTOCOLE.md` et `PROTOCOLE_PHASE2.md`
(règles communes, régime, walk-forward, critères). Paramètres : `config.yaml`, sections `concepts` et `phase3`.

## 1. Univers et portefeuille

- Univers de développement : membres du top 30 mensuel point-in-time (Phase 1) **sans les 105 paires mises de côté**
  (197 paires, 1 829 paires-mois, paires délistées comprises). Un signal n'est pris que si sa paire est membre de
  l'univers le mois du signal ; une position ouverte reste suivie jusqu'à sa sortie.
- Portefeuille simulé commun à tous les concepts : 1 % de risque par trade, 5 positions au plus, une par paire,
  au plus 3 positions dans le même sens parmi les paires corrélées à BTC (corrélation des rendements journaliers
  sur 30 jours ≥ 0,7), perte journalière maximale 3 %.
- Mêmes coûts, même moteur, même walk-forward (24 mois de réglage, 6 mois de test, 2022-01 → 2026-10).

## 2. Concepts et grilles

**C1 et C2** : règles et grilles identiques à la Phase 2 (72 + 81 variantes, sens long / short / les deux),
appliquées à tout l'univers.

**C3 mean reversion bornée** (sens : les deux, rapporté par sens et par régime range / tendance) :
- Tendance de fond : clôture du timeframe de contexte au-dessus (long) ou en dessous (short) de son EMA 200.
- Entrée long : RSI(p) ≤ 10 et écart à la moyenne : `bb` = clôture sous la bande de Bollinger basse (20, 2) ;
  `vwap` = clôture sous la VWAP glissante 20 bougies − 1,5 ATR. Short symétrique (RSI ≥ 90).
- Objectif : moyenne mobile 20 de la bougie du signal (fixée à l'entrée) ; stop 1,5 ATR ; sortie au plus tard
  après 10 bougies.
- Grille : timeframe {1h, 4h, 1D} × p {2, 3, 5} × écart {bb, vwap} = **18 variantes**.

**C4 funding / open interest** (timeframe 1h, sens : les deux) :
- `funding_abs` : z-score du funding par rapport aux règlements des W jours précédents ; z ≥ +s → short
  (longs surchargés), z ≤ −s → long. Signal à la première clôture 1h qui suit le règlement.
- `funding_rel` : même règle sur l'écart entre le funding de la paire et la médiane des paires de l'univers au même
  règlement (le « relatif entre paires » de l'hypothèse).
- `oi_purge` : open interest en baisse d'au moins θ sur 24 h ; prix en baisse d'au moins 3 % → long (purge des
  longs) ; prix en hausse d'au moins 3 % → short (purge des shorts). Premier signal de chaque épisode.
- Sortie : stop 2 ATR(1h), objectif 2 R, sortie au plus tard après 48 h.
- Grille : {funding_abs, funding_rel} × W {7, 30} × s {2, 3} + oi_purge × θ {10 %, 15 %} = **10 variantes**.
  L'open interest n'existe qu'à partir de 2020-09 (BTC) ou 2021-12 (la plupart des paires) : le walk-forward
  ne trade `oi_purge` que lorsque 10 trades de réglage existent.
- C4 **en filtre** : voir la section 4.

**C5 SMC reversal** (sens : les deux) :
- Liquidité `equal` = equal highs / lows de pivots fractals confirmés (n = 3, tolérance 0,15 %, 100 bougies) ;
  `period` = plus haut / plus bas de la veille (1h) ou de la semaine précédente (4h).
- Séquence : sweep (mèche au-delà d'un niveau intact, clôture de réintégration) → CHoCH dans le sens opposé
  dans les 10 bougies (pivots fractals n = 3) → zone de l'impulsion entre le sweep et le CHoCH, confirmée au
  plus tard au CHoCH : `fvg` ou `ob` (order block avec displacement et rupture de structure, Phase 1) → ordre
  limite au milieu de la zone, valable 10 bougies, rempli seulement si le prix traverse le niveau.
- Stop : extrême du sweep ± 0,25 ATR. Objectif ∈ {2 R, 3 R}.
- Score de top / bottom 0-100 : sweep 25, divergence RSI(14) entre le pivot balayé et le sweep 20, volume climax
  (> 2 × moyenne des 20 bougies précédentes) 15, proximité d'un niveau de la veille / semaine (0,5 ATR) 20,
  CHoCH rapide (≤ 3 bougies) 20. Seuil ∈ {0, 60}.
- Grille : timeframe {1h, 4h} × liquidité {equal, period} × zone {fvg, ob} × objectif {2, 3} × seuil {0, 60}
  = **32 variantes**. Mesures publiées : retard moyen de confirmation (sweep → CHoCH), mouvement favorable et
  défavorable moyens après l'entrée, part des pivots balayés qui restent l'extrême.

## 3. Groupes du walk-forward

C1 et C2 : timeframe × sens (18 groupes). C3 : par timeframe (3). C4 : un groupe (10 variantes). C5 : par
timeframe (2). Total : 24 groupes. Règle de sélection inchangée (meilleure espérance de réglage, ≥ 10 trades).

## 4. Ablations (apport marginal, avec / sans, sur les variantes retenues par le walk-forward, même sélection)

- C1 : + filtre volume relatif > 1,2 ; − composante ADX du régime ; − composante momentum du régime.
- C2 : − ADX ; − momentum.
- C1, C2, C3 : + filtre funding (C4) : pas de long si z-score du funding sur 30 jours ≥ 2, pas de short si ≤ −2.
- Un filtre n'est conservé que s'il améliore l'espérance hors échantillon.

## 5. Critères

Ceux de `PROTOCOLE.md` (1 à 8) par groupe, avec le test SPA sur les 213 variantes de la grille et le DSR avec
tous les essais. **Critère 9 (paires mises de côté)** : évalué seulement pour les groupes qui passent 1 à 8, en
rejouant les mêmes variantes, fenêtre par fenêtre, sur les membres mis de côté ; les paires mises de côté ne sont
pas lues autrement. **Critère 10 (test final)** : impossible aujourd'hui (16 jours de données futures) ; un groupe
qui passe 1 à 9 devient « candidat en attente du test final » et seulement ensuite « edge confirmé ».

Portefeuille des survivants (corrélation, drawdown combiné, comparaison au buy-and-hold BTC et au panier) :
seulement s'il y a au moins un survivant.

## 6. Compteur d'essais

Grille : 72 + 81 + 18 + 10 + 32 = **213** ; ablations : 9 (volume) + 18 (ADX) + 18 (momentum) + 21 (funding) = **66** ;
total de la phase **279**, soit **1 186** avec les 907 déjà comptés.

## 7. Interdits

Identiques à la Phase 2 : aucune modification de grille, de règle, de sélection ou de seuil après le premier calcul.
Toute correction est datée, le calcul relancé en entier, les essais recomptés.
