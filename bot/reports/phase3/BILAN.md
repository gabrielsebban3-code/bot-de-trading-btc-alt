# Bilan de la Phase 3 (2026-11-18)

Rapport complet : [`PHASE3.md`](PHASE3.md). Protocole : [`../../PROTOCOLE_PHASE3.md`](../../PROTOCOLE_PHASE3.md).

## Verdict

**Aucun concept n'a d'edge démontré. Aucun n'est activé. La Phase 5 (déploiement, affichage sur Dinexo) n'est
pas construite**, conformément à la règle de la mission.

- 24 groupes testés (C1 à C5, 197 paires point-in-time, walk-forward 2022-01 → 2026-10, nets de tous les coûts).
- 0 candidat : aucun groupe ne passe les critères 1 à 8, donc les paires mises de côté (critère 9) n'ont **pas**
  été lues. Elles restent neuves pour le test final.
- 17 groupes « pas d'edge » (espérance négative ou nulle), 7 « non concluants » (espérance positive mais
  non prouvée).
- Test SPA sur les 213 variantes : p = 0,669 (il faut < 0,05). DSR = 0,00 partout (il faut > 0,95), avec 1 411
  essais comptés au total.

## Par concept

| Concept | Résultat hors échantillon | Lecture |
|---|---|---|
| C1 cassure de tendance | 1h et 4h « long + short » négatifs ; 4 groupes positifs | Voir ci-dessous : les groupes positifs ne battent pas le hasard |
| C2 repli en tendance | Négatif en 1h, nul en 4h et 1D « both » ; shorts 4h et 1D positifs | Même lecture que C1 |
| C3 retour à la moyenne | Clairement négatif (1h : −0,081 R sur 11 901 trades, IC entièrement < 0) | Pas d'edge. En 1h, le capital simulé est entièrement perdu (drawdown affiché 100,6 %, voir les limites) |
| C4 funding / OI | −0,104 R sur 4 071 trades, IC entièrement < 0 | Pas d'edge. En filtre, le funding n'améliore rien de façon régulière (ablations) |
| C5 SMC reversal | 1h : −0,029 R (683 trades) ; 4h : −0,269 R (75 trades) | Pas d'edge. Retard moyen sweep → CHoCH : 6,2 bougies (1h), 6,4 (4h). Excursion défavorable moyenne ≈ 1 R : le prix revient souvent au stop avant de partir |

## Pourquoi les 7 groupes positifs ne prouvent rien

1. **Ce sont surtout des shorts** (C1 4h et 1D short, C2 4h et 1D short). Pour trois des quatre, des entrées
   **tirées au hasard** avec la même sortie font mieux. Pour C1 1D short, par exemple : +0,295 R contre +0,574 R au
   95e centile du hasard. Sur 2022-2026, la plupart des altcoins ont baissé. Ce qui gagne, c'est d'être short sur
   ce marché avec un stop suiveur, pas le signal. Le groupe le moins clair est C2 4h short : +0,148 R, IC 95 %
   [+0,024 ; +0,283], 4 années positives sur 5, voisines 100 % positives, à peine au-dessus du 95e centile du
   hasard (+0,148). Il échoue au SPA et au DSR, qui tiennent compte des 1 411 essais : c'est exactement ce qu'on
   attend d'un des meilleurs parmi des centaines de tirages.
2. **C1 1h long (+0,050 R) repose sur un seul trade** : MYXUSDT en septembre 2025, entrée à 1,34 et sortie à
   15,08 (+227,7 R, pompe réelle vérifiée dans les données). Sans les 5 meilleurs trades, l'espérance est
   −0,119 R.
3. Les groupes « both » (variantes long + short), qui ne profitent pas de ce biais du marché, sont tous négatifs
   ou nuls.

## Ablations (information)

- Retirer l'ADX du régime améliore souvent l'espérance, mais les écarts restent du même ordre que le bruit
  (quelques centièmes de R) et aucun groupe ne devient positif de façon significative.
- Les filtres funding et volume n'apportent rien de régulier.
- Aucune conclusion n'en est tirée : ce sont des essais comptés, pas des réglages à appliquer.

## Ce qui se passe maintenant (Phase 4, déjà codée)

- La liste figée des variantes observées est écrite par la règle de `PROTOCOLE_PHASE4.md` dans
  `observation.json` : 7 variantes, celles des groupes à espérance positive, sans choix à la main.
- Le détecteur doit tourner **sur ton ordinateur** (les serveurs américains, dont GitHub Actions, reçoivent
  l'erreur 451 de Binance). Il les suit en papier à partir du 2026-11-01, sans rien envoyer sur Discord. Guide :
  [`../../INSTALLATION.md`](../../INSTALLATION.md).
- Après au moins 100 trades clos ET 3 mois, `forward-report` dira si l'une d'elles tient sur des données
  réellement neuves (critère 10). C'est le seul test qui peut encore changer le verdict. Vu ce qui précède, il
  faut s'attendre à ce qu'aucune ne passe.

## Limites connues de ce bilan

- **Équité négative en C3 1h.** Les tailles sont calculées sur le capital à l'entrée. Quand le capital simulé
  approche de zéro, des positions ouvertes en même temps peuvent perdre un peu plus que ce qui reste. En marge
  isolée, ce serait impossible : la perte d'une position est limitée à sa marge. L'effet est de quelques dizaines
  d'unités sur 10 000 et n'est pas corrigé, puisque le verdict « pas d'edge » ne dépend pas du capital (les
  espérances sont en R).
- Toutes les données 2020-2026 avaient déjà été utilisées par les études précédentes. Seuls le futur et les paires
  mises de côté sont neufs.
- Ce n'est pas un conseil financier.
