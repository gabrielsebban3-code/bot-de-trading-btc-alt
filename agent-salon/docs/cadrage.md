# 📘 Cadrage du projet — décisions de référence

Ce document fige les décisions prises au démarrage. C'est la **source de vérité**
du projet : on s'y réfère à chaque étape.

## Décisions verrouillées

| # | Sujet | Décision |
|---|-------|----------|
| 1 | Canal | 📞 Voix — appels téléphoniques |
| 2 | Mission principale | 📅 Prise de rendez-vous |
| 3 | Marché n°1 | 💇 Coiffeurs / barbiers / esthétique |
| 4 | Agenda | 🗓️ Google Calendar / Outlook |
| 5 | Profil porteur | 🎯 Business/vente (la technique est déléguée) |
| 6 | Méthode de build | ⚡ Plateforme voix managée (Vapi) + couche métier maison |
| 7 | Langue | 🇫🇷 Français uniquement |
| 8 | Délai | 🗓️ Quelques semaines, V1 propre |
| 9 | Arrivée des appels | 🔀 Deux modes : débordement **et** standard complet |
| 10 | Périmètre fonctionnel | Prendre + modifier/annuler + FAQ + prendre message + transfert humain |
| 11 | Salon pilote | 🏗️ Aucun au départ → salon fictif « L'Atelier Coiffure » pour la démo |
| 12 | Budget outils | 💶 50–200 €/mois en phase de construction |
| 13 | Style du salon démo | Salon mixte coupe & couleur |

## Modèle économique visé
- **Coût réel** d'un appel : ~0,10–0,20 € / minute (téléphonie + IA + voix).
- **Prix de vente cible** : 99–199 €/mois par salon (abonnement).
- **Logique** : marge récurrente, produit duplicable d'un salon à l'autre.

## Stack technique (haut niveau)
- **Plateforme voix** : Vapi (téléphonie + reconnaissance vocale + synthèse vocale orchestrées)
- **Cerveau (LLM)** : Claude (excellent en français et en compréhension fine)
- **Reconnaissance vocale** : Deepgram (français, faible latence)
- **Synthèse vocale** : Cartesia ou ElevenLabs (voix française naturelle)
- **Agenda** : Google Calendar API (branché en Phase 2)

## ⚠️ Point de conformité (RGPD) — à traiter en Phase 4
Données personnelles manipulées (nom, téléphone, RDV) + enregistrement éventuel
des appels. À prévoir : information du client, consentement, hébergement des
données, durée de conservation. Non bloquant pour la démo, intégré avant la vente.
