# Protocole de l'étude 7 : stratégies journalières documentées par la recherche

Rédigé le 2026-11-17 avant tout calcul et avant tout téléchargement des nouvelles paires. Paramètres figés dans
`config/etude7.yaml`.

## 1. Pourquoi ces trois familles

Recherche faite le 2026-11-17 (sources dans `RAPPORT_ETUDE_7.md`) :
- suivi de tendance journalier (time-series momentum) : l'effet le mieux documenté sur les marchés à terme ;
- momentum relatif entre cryptos : documenté, mais un facteur publié s'effondre après correction (2026) ;
- carry crypto (spot acheté, perpétuel vendu) : rendement moyen > 10 % par an selon la BIS, risque de marge.
Aucune des trois n'a été testée dans les études 1 à 6 (qui portaient sur des signaux en 15m, 1h et 4h).

## 2. Données

- 20 paires d'origine (`config/pairs.json`) et **20 paires jamais utilisées** (rangs 21 à 40 du classement
  de volume, `results/pair_selection.json`), dont PAXGUSDT (or tokenisé, gardé tel que classé).
- Bougies journalières des perpétuels (archives mensuelles 1d), funding réel, bougies journalières du spot pour le
  carry (pour une paire `1000X`, le spot `X` ; seuls les rendements servent). Paire sans spot : exclue du carry.

## 3. Règles (signal à la clôture d'un jour, position tenue le jour suivant)

- **TSMOM** : chaque lundi 00:00 UTC, signe du rendement sur L jours (L = 20, 60 ou 120). Variante achat et vente,
  ou achat seulement (sinon à plat). Poids = signe × 10 % / volatilité annualisée sur 60 jours, divisé par le
  nombre de paires disponibles ; levier brut plafonné à 2.
- **XSMOM** : chaque lundi, classement des paires par rendement sur L jours (7 ou 28) ; achat des k meilleures,
  vente des k moins bonnes (k = 3 ou 5), poids égaux, levier brut 1.
- **CARRY** : chaque jour, pour chaque paire : position ouverte si le funding moyen des W derniers jours (3 ou 14)
  annualisé dépasse le seuil (0 % ou 10 %), fermée sinon. Capital réparti en parts égales entre les paires ; dans
  une part, spot acheté et perpétuel vendu pour le même notionnel, la marge du perpétuel immobilisant 25 % du
  notionnel. Résultat = rendement du spot − rendement du perpétuel + funding reçu − frais.
- Coûts : perpétuel 0,05 % par côté, spot 0,10 % par côté, slippage 0,02 % sur chaque ordre, funding réel payé ou
  reçu sur chaque position perpétuelle. Les coûts portent sur le volume échangé à chaque rééquilibrage.
- Pas de stop par trade : ce sont des stratégies de portefeuille dimensionnées par la volatilité, comme dans la
  littérature. Le risque est mesuré par la volatilité et le drawdown du portefeuille.

## 4. Sélection et validation

1. Dans chaque famille, la variante au meilleur Sharpe net sur l'échantillon d'origine 2020-2023 est gardée.
2. Elle est évaluée telle quelle sur deux jeux hors échantillon :
   (a) les paires d'origine, 2024-01 → 2026-10 ;
   (b) les 20 paires jamais utilisées, 2020-01 → 2026-10.
3. Critères, tous obligatoires sur (a) et sur (b) : Sharpe net ≥ 1 ; borne basse de l'intervalle de confiance du
   Sharpe > 0 ; drawdown < 25 % ; rendement positif avec coûts ×2 ; ≥ 60 % des trimestres positifs ; positif
   dans au moins 2 des 3 régimes (hausse, baisse, range selon le rendement du BTC sur 90 jours, au-delà de ±20 %) ;
   Sharpe supérieur à celui du buy & hold du panier égal des mêmes paires.
4. Stabilité, sur l'échantillon d'origine : le paramètre principal décalé de ±20 % garde un Sharpe > 0.
5. Une stratégie qui remplit tout est « retenue » et passe en paper trading. Sinon : « aucune ».

## 5. Réserves écrites avant le calcul

- 206 variantes ont déjà été testées sur les paires d'origine ; la période 2024-2026 de ces paires a été vue.
  Le jeu (b) est le seul totalement neuf, mais ses paires évoluent comme les autres (marché commun).
- Le carry n'est pas un signal de direction ; son risque principal (liquidation de la jambe vendue dans une hausse
  violente, faillite de plateforme) est mal mesuré par un backtest journalier.
- 14 variantes dans cette étude ; 220 au total sur ces marchés.
