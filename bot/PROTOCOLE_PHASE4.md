# Protocole de la Phase 4 : détecteur live en observation privée

Écrit le 2026-11-18, **avant d'avoir vu les résultats de la Phase 3** (calcul en cours). Décision de Gabriel :
mode « observation privée » tant qu'aucun concept n'est « edge confirmé ».

## 1. Ce qui est observé (liste figée par une règle, pas par un choix à la main)

- Tout groupe de la Phase 3 classé « candidat » (critères 1 à 9) ;
- et tout groupe dont l'espérance hors échantillon de la Phase 3 est strictement positive ;
- pour chaque groupe retenu : la variante **retenue par le walk-forward sur la dernière fenêtre** (2026-07),
  c'est-à-dire celle qu'un utilisateur du système aurait en production au 1er novembre 2026.
- La liste est écrite par le code (`python -m bot.main observation-list`) dans `reports/phase3/observation.json`,
  qui n'est jamais publiée sur le site.

## 2. Ce que fait le détecteur

- Bougies closes uniquement, univers top 30 recalculé chaque mois comme en backtest (paires mises de côté
  incluses, marquées comme telles), mêmes concepts, même moteur, mêmes coûts.
- Chaque signal est enregistré une fois (identifiant déterministe), puis suivi en papier jusqu'à sa sortie :
  en attente, actif, stop remonté, sorti en gain, sorti en perte, expiré, invalidé.
- Surveillance : une variante est désactivée si l'espérance de ses 50 derniers signaux est négative ou si son
  drawdown dépasse 1,5 fois celui du backtest.
- **Mode observation : aucune alerte Discord n'est envoyée.** Le passage en mode `alerts` n'est autorisé que pour
  une variante « edge confirmé » (critère 10 réussi), après la période d'observation.

## 3. Test final (critère 10)

Quand une variante observée atteint au moins 100 signaux clos ET 3 mois d'observation, son résultat est mesuré
une seule fois (`python -m bot.main forward-report`) : espérance positive et pas significativement inférieure à
la validation. C'est le test final ; le résultat est définitif pour cette variante.
