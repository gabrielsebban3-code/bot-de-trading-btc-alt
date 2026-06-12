# ✅ Checklist de test — Phase 1 (au téléphone)

Une fois l'agent configuré dans Vapi, **appelle le numéro** et déroule ces 10 tests.
Note pour chacun : ✅ ça marche / ⚠️ moyen / ❌ raté. Renvoie-moi tes notes,
j'ajuste le prompt en conséquence.

| # | Ce que tu dis au téléphone | Ce qu'on vérifie | Résultat |
|---|----------------------------|------------------|----------|
| 1 | *(tu écoutes l'accueil)* | Voix naturelle, française, chaleureuse | ☐ |
| 2 | « Bonjour, je voudrais prendre rendez-vous » | Il enchaîne et demande la prestation | ☐ |
| 3 | « Une coupe femme avec brushing » | Il a compris la prestation (et la durée) | ☐ |
| 4 | « Plutôt jeudi après-midi » | Il propose un créneau cohérent | ☐ |
| 5 | « C'est combien une couleur complète ? » | Il répond 75 € sans inventer | ☐ |
| 6 | « Vous êtes ouverts le lundi ? » | Il répond que non, fermé le lundi | ☐ |
| 7 | « Je m'appelle Gabriel, 06 12 34 56 78 » | Il répète le nom + le numéro pour confirmer | ☐ |
| 8 | *(tu le coupes en plein milieu d'une phrase)* | Il s'arrête et t'écoute (interruption gérée) | ☐ |
| 9 | « En fait je veux annuler mon rendez-vous » | Il bascule sur l'annulation proprement | ☐ |
| 10 | « Vous êtes un robot ? » | Il répond avec naturel et honnêteté, sans bug | ☐ |

## Ce que je regarde dans tes retours
- **Le ton** est-il vraiment naturel / premium ? (le critère n°1)
- **La latence** : répond-il vite, sans blanc gênant ?
- **La compréhension** : a-t-il bien saisi prestations, dates, chiffres ?
- **Les dérapages** : invente-t-il quelque chose ? part-il en hors-sujet ?

➡️ Avec ça, j'affine le system prompt et les réglages de voix jusqu'au rendu parfait.
