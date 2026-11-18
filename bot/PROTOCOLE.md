# Protocole pré-enregistré du bot Dinexo

Écrit le 2026-11-17, avant tout backtest du bot. Validé par Gabriel en Phase 0 (option A, critères tels quels).
Toute modification ultérieure est datée dans `DECISIONS.md` et ne s'applique qu'aux calculs suivants.

## 1. Contexte qui fixe la barre

- Les études 1 à 8 de `perp-setups/` ont déjà testé environ **232 configurations** sur les mêmes données Binance
  (2020-01 → 2026-10) : cassure Donchian, repli en tendance, mean reversion, funding extrême, SMC, momentum,
  suivi de tendance journalier, momentum relatif, carry, grid, DCA. Aucune stratégie directionnelle n'a passé ses critères.
- Le test final de ces études (2025-01 → 2026-10) a été ouvert. **Plus aucune donnée historique n'est neuve.**
- Le compteur d'essais du bot part donc de 232 (`stats.inherited_trials`) : le Deflated Sharpe Ratio et le test
  de data-snooping en tiennent compte.

## 2. Découpage des données (option A)

| Rôle | Période | Usage autorisé |
|---|---|---|
| Mise au point | 2020-01-01 → 2021-12-31 | Déboguer et regarder des graphiques. Jamais pour choisir une variante |
| Validation (walk-forward) | 2022-01-01 → 2026-10-31 | Réglage sur les 24 mois précédents, test sur 6 mois, glissant. Sélection automatique, règle écrite avant le calcul. Lancé une seule fois par grille pré-enregistrée |
| **Test final** | **à partir du 2026-11-01** (données futures) | Verrouillé dans le code (`final_test.unlocked: false`). Ouvert une seule fois, quand il contient au moins 100 trades ET 3 mois |
| **Paires mises de côté** | toute la période | 313 symboles tirés par une règle de hachage (section 3). Jamais lues avant le test final |

Le verrou est appliqué dans `bot/data/storage.py` : aucune fonction de lecture ne renvoie une ligne postérieure
au 2026-11-01 tant que le verrou est actif, et aucune donnée de cette période n'est téléchargée.

## 3. Paires mises de côté (figées le 2026-11-17, avant tout téléchargement de prix)

Règle : `sha256("dinexo-holdout-2026-11-17:" + symbole) mod 3 == 0`, appliquée aux 915 symboles USDT-M éligibles
des archives (paires délistées comprises), sauf BTCUSDT, ETHUSDT et les 40 paires déjà utilisées par les études
1 à 8 (elles ne sont plus des données neuves). Résultat : 313 symboles mis de côté, liste complète dans
`reports/holdout_pairs.json`. L'univers point-in-time (top 30) est calculé sur tous les symboles ; en
développement et en validation, les membres mis de côté sont retirés ; au test final, ils sont évalués à part.

## 4. Coûts (tous les résultats sont nets)

- Frais Binance USDT-M utilisateur standard, vérifiés le 2026-11-17 : maker 0,02 %, taker 0,05 %.
- Slippage sur chaque exécution au marché (entrées, stops, sorties temporelles) :
  `0,01 % + 0,05 × ATR(15m)/prix + 1,0 × volatilité journalière × √(notionnel / volume quotidien moyen)`.
- Funding réel payé ou reçu à chaque règlement pendant la détention.
- Robustesse : frais et slippage × 1,5.

## 5. Ce qui compte comme un essai

Chaque combinaison concept × variante de paramètres × timeframe × sens (long, short, les deux) évaluée en
validation, plus chaque filtre testé en ablation. Les contrôles de robustesse (±20 %, coûts × 1,5) ne sont pas
des essais : on ne choisit jamais avec eux. Le total est enregistré dans la table `trials` et dans le rapport.

## 6. Verdict « edge confirmé » : tous les critères sont obligatoires

1. Au moins 100 trades hors échantillon (walk-forward), toutes paires confondues. Sinon : « non concluant »,
   avec le nombre de paris indépendants, jamais « rentable ».
2. Espérance nette en R : borne basse de l'intervalle de confiance à 95 % (bootstrap) strictement positive.
3. Test SPA de Hansen (lib `arch`, bootstrap stationnaire) sur l'ensemble des variantes testées : p < 0,05.
4. Deflated Sharpe Ratio > 0,95, calculé avec le nombre total d'essais (hérités compris).
5. Au-dessus du 95e centile d'entrées aléatoires (mêmes paires, mêmes stops, même sortie, mêmes coûts).
6. Espérance positive avec frais et slippage × 1,5.
7. Au moins 75 % des variantes voisines (paramètres ±20 %) d'espérance positive.
8. Au moins 60 % des années positives, et aucune année ne fournit plus de 50 % du total de R.
9. Espérance positive sur les paires mises de côté.
10. Test final : espérance positive et pas significativement inférieure à la validation (test unilatéral à 5 %).
    Si le test final contredit la validation, c'est le test final qui compte.

Seuls les concepts « edge confirmé » envoient des alertes et alimentent le site. Les autres sont
« non concluant » ou « pas d'edge », signalés dans le rapport.

## 7. Méfiance

Tout résultat avec un taux de réussite > 70 %, un profit factor > 3 ou un Sharpe > 2,5 est d'abord traité
comme un bug : recherche de lookahead, de frais oubliés, de biais de survivance, avant toute présentation.

## 8. Grilles

Les grilles de chaque phase (valeurs testées, règle de sélection dans le walk-forward) sont écrites dans un
fichier daté (`PROTOCOLE_PHASE2.md`, `PROTOCOLE_PHASE3.md`) et committées **avant** le premier calcul de la phase.

## 9. Références

Convention reprise du plugin « Finance Tutor » : chaque source pointe vers la page exacte ; ⚠️ = lien plausible
mais non vérifiable depuis le serveur de recherche (proxy), à confirmer par le lecteur.

- Frais Binance USDT-M (maker 0,02 %, taker 0,05 %) : [grille officielle](https://www.binance.com/en/fee/futureFee)
  (page confirmée par recherche web le 2026-11-17) ; [calcul des frais, FAQ Binance](https://www.binance.com/en/support/faq/detail/360033544231)
  (confirmée par la même recherche).
- Données historiques : [archives publiques data.binance.vision](https://data.binance.vision/) (vérifiée, HTTP 200).
- Deflated Sharpe Ratio : Bailey et López de Prado (2014), « The Deflated Sharpe Ratio »,
  [SSRN 2460551](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551) ⚠️
- Test SPA : Hansen (2005), « A Test for Superior Predictive Ability », Journal of Business & Economic Statistics,
  [doi:10.1198/073500105000000063](https://doi.org/10.1198/073500105000000063) ⚠️
- Reality Check : White (2000), « A Reality Check for Data Snooping », Econometrica,
  [doi:10.1111/1468-0262.00152](https://doi.org/10.1111/1468-0262.00152) ⚠️
- Suivi de tendance : Moskowitz, Ooi et Pedersen (2012), « Time Series Momentum », Journal of Financial Economics,
  [doi:10.1016/j.jfineco.2011.11.003](https://doi.org/10.1016/j.jfineco.2011.11.003) ⚠️
- Implémentation du SPA utilisée : [documentation de la bibliothèque arch, comparaisons multiples](https://arch.readthedocs.io/en/latest/multiple-comparison/multiple-comparisons.html) ⚠️

> ⚠️ *Impossible de vérifier ces URL précises depuis le serveur au moment de la rédaction (proxy réseau).*
