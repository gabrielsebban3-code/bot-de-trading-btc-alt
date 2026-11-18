# Bilan de la Phase 2 : C1 et C2 sur BTC et ETH (1h, 4h, 1D)

Date : 2026-11-18. Rapport chiffré complet : [`PHASE2.md`](PHASE2.md). Protocole : `../../PROTOCOLE_PHASE2.md`
(committé avant le calcul, commit 19d9eb5).

## Verdict

**Aucun des 18 groupes (concept × timeframe × sens) ne passe les critères de validation. Aucun candidat C1 ou C2
pour la Phase 3. Il n'y a pas d'edge démontré pour la cassure de tendance ni pour le repli dans la tendance sur
BTC et ETH, nets de frais, hors échantillon.**

| | C1 cassure de tendance | C2 repli dans la tendance |
|---|---|---|
| Groupes à espérance hors échantillon > 0 | 7 sur 9 | 0 sur 9 |
| Meilleur groupe | 1h long : +0,14 R, 221 trades, IC 95 % [−0,13 ; +0,47] | 4h short : −0,05 R |
| Bat le hasard (95e centile, même sortie) | aucun | aucun |
| Statut | « non concluant » (positif mais non significatif) ou « pas d'edge » | « pas d'edge » partout |

- **Test SPA de Hansen** sur les 153 variantes : p = 0,96. Rien ne bat significativement le fait de rester à plat
  une fois pris en compte le nombre de variantes testées.
- **Deflated Sharpe** ≈ 0 pour tous les groupes (907 essais comptés au total).
- **Aucun résultat suspect** (taux de réussite, profit factor et Sharpe tous dans des zones normales pour du suivi
  de tendance : 24 à 42 % de gagnants, PF 0,5 à 1,5).

## Ce que montrent les chiffres

1. **La cassure (C1) est légèrement positive, mais ce n'est pas l'entrée qui gagne.** Le meilleur groupe (1h long,
   +0,14 R) est au 93e centile d'entrées **tirées au hasard** avec le même stop suiveur, dans le même sens long :
   la plus grande partie du gain vient de la sortie (laisser courir) et de la hausse de fond, pas du signal.
   Même constat qu'à l'étude 2 de `perp-setups`.
2. **Les longs font mieux que les shorts** (C1 : +0,05 R long contre −0,03 R short, toutes variantes confondues) :
   la dérive haussière historique de la crypto, comme le cahier des charges l'anticipait. Le seul short positif
   (C1 4h, +0,19 R) repose sur 76 trades, gagnés surtout en 2022 (marché baissier).
3. **Instabilité dans le temps** : C1 1h long tire plus de la moitié de son résultat de 2023 (dont +24 R sur le
   seul 1er trimestre 2023). BTC fait +0,27 R par trade, ETH +0,02 R.
4. **C2 perd partout.** Attendre un repli puis une cassure de structure en timeframe inférieur n'apporte rien : les
   stops structurels sont serrés, les coûts pèsent davantage, et le chandelier sort trop tôt.
5. **Comparaison des trois méthodes de pivots** (Étape 4, C2, espérance moyenne pondérée, 2022-2026) : fractal
   −0,11 R, ZigZag −0,05 R, hiérarchique −0,04 R. Les pivots plus « lents » perdent moins, parce qu'ils donnent
   moins de signaux et des stops plus larges, mais aucun ne rend C2 positif.
6. **Filtre volume relatif > 1,2 (ablation)** : il améliore l'espérance dans 7 groupes C1 sur 9, de +0,01 à
   +0,12 R, sans rendre un seul groupe significatif. Selon le protocole, il serait conservé là où il aide ; c'est un
   signe faible et cohérent avec l'étude 5 (les cassures avec du volume font un peu mieux), à confirmer sur 30 paires.
7. **Le 1D n'est pas concluant par construction** : 22 à 65 trades sur 2 paires en 5 ans, très loin des 100 trades
   exigés. Ce timeframe ne pourra être jugé qu'avec l'univers complet.
8. **Buy-and-hold** sur 2022-2026 : BTC +68 % (Sharpe 0,46, drawdown 67 %), panier BTC + ETH +10 % (Sharpe 0,32).
   Les meilleures variantes C1 ont un drawdown bien plus faible (5 à 26 %) mais un Sharpe du même ordre (≤ 0,37) :
   aucune supériorité ajustée du risque démontrée.

## Deux défauts trouvés et corrigés pendant la phase (transparence)

| Passage | Défaut | Effet | Archive |
|---|---|---|---|
| 1 | Plafond de distance de stop à 6 % (hérité de l'étude 1) | 275 signaux C1 1D sur 279 et 265 C1 4h sur 913 rejetés | `../phase2_run1_maxstop6/` |
| 2 | Liquidation en marge isolée 5 × fixe avec des stops larges | 2 trades 1D « liquidés » avant leur stop à −0,8 R | `../phase2_run2_liquidation/` |
| 3 | — | Résultat retenu | ce dossier |

Les deux défauts ont été repérés par des contrôles de cohérence (un groupe à 0 trade, un motif de sortie anormal),
pas en cherchant un meilleur résultat. Les trois passages donnent la même conclusion (aucun candidat, SPA p ≈ 0,96).
Les essais des trois passages sont tous comptés (règle 8 du protocole) : **907 essais au total**.

## Risque de surapprentissage

Élevé par construction : 907 essais sur des données déjà exploitées par huit études. C'est précisément pour cela que
le walk-forward, le test SPA et le DSR ont été utilisés. Ils disent tous la même chose : rien de ce qui a été testé
ici ne se distingue du hasard.

## Conséquence pour la suite

- C1 et C2 restent **désactivés** sur BTC et ETH. Aucun signal, aucune alerte.
- La Phase 3 testerait C1 et C2 sur tout l'univers (environ 30 paires par mois, donc 10 à 15 fois plus de trades et
  des intervalles de confiance beaucoup plus étroits), plus C3, C4 et C5.
- Attente honnête : les études 1 à 8 et cette phase pointent toutes vers l'absence d'edge directionnel net de frais
  sur ces timeframes. Le scénario le plus probable reste « aucun concept validé, pas de Phase 5 ». La Phase 3
  garde de la valeur : elle répond définitivement avec l'univers complet, les paires délistées et les paires
  mises de côté.
