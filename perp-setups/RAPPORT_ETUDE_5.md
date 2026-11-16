# Étude 5 : un modèle qui note les signaux du momentum 1H — résultat

Protocole : `PROTOCOLE_ETUDE_5.md` (enregistré avant le calcul). Fichiers : `results_etude5/`. Le test final n'a pas été lu.

## Verdict

**Le modèle n'apporte rien de plus qu'une règle simple.** Il sait classer les signaux, mais une fois les trades passés dans le moteur, sa meilleure variante fait +0,099 R par trade sur la validation, moins que le momentum sans modèle avec un volume ≥ 3× (+0,137 R). Selon le protocole, la partie apprentissage n'est pas construite et le test final n'est pas ouvert.

## Résultats

Entraînement : 2021-08-01 → 2024-01-31. Validation : 2024-02-01 → 2025-05-31. 29071 signaux candidats ; modèle réentraîné chaque mois, notes toujours hors échantillon.

| Variante | Entraînement : E[R] (trades) | Validation : E[R] (trades) | Validation : PF | Validation : drawdown | Critères ratés (validation) |
|---|---|---|---:|---:|---|
| Sans modèle, volume ≥ 2× (tous les candidats) | +0,015 R (4598) | +0,030 R (2866) | 1,04 | 53,3 % | c2,c3,c4,c5,c6,c8 |
| Sans modèle, volume ≥ 3× (référence) | +0,033 R (2599) | +0,137 R (1830) | 1,20 | 30,9 % | c2,c3,c4 |
| Modèle : 60 % les mieux notés | +0,034 R (3920) | +0,088 R (2400) | 1,12 | 39,4 % | c2,c3,c4 |
| Modèle : 40 % les mieux notés | +0,096 R (3023) | +0,067 R (1974) | 1,09 | 48,7 % | c2,c3,c4 |
| Modèle : 20 % les mieux notés | +0,146 R (1698) | +0,099 R (1278) | 1,14 | 43,1 % | c2,c3,c4 |

c2 = espérance > 0,15 R ; c3 = profit factor > 1,3 ; c4 = drawdown < 25 % ; c5 = paires positives ; c6 = Monte Carlo ; c8 = buy & hold.

## Lecture honnête

- **Le modèle a une vraie capacité de tri.** Signaux simulés un par un sur la validation : les mieux notés font +0,134 R en moyenne contre +0,026 R pour l'ensemble, mieux que 100 % de 1 000 tirages au hasard de même taille.
- **Mais il ne bat pas la règle la plus simple** : exiger un pic de volume de 3× au lieu de 2× fait aussi bien ou mieux, sans modèle. L'essentiel de ce que le modèle apprend, c'est que les gros pics de volume marchent mieux.
- **Aucune variante ne remplit les critères** : espérance, profit factor et drawdown restent hors seuils partout.
- 3 variantes testées ici ; 192 au total sur ces données avec les études précédentes.
