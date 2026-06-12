# 📘 Cadrage du projet — décisions de référence

Ce document fige les décisions prises au démarrage. C'est la **source de vérité**
du projet : toute évolution se décide ici, par écrit, avant d'être construite.

## 1. Décisions verrouillées

| # | Sujet | Décision | Conséquence concrète |
|---|-------|----------|----------------------|
| 1 | Canal | 📞 Voix — appels téléphoniques | Exigence n°1 : voix FR naturelle + réponse < 1 s |
| 2 | Mission principale | 📅 Prise de rendez-vous | L'agent doit lire/écrire un agenda réel (Phase 2) |
| 3 | Marché n°1 | 💇 Coiffeurs / barbiers / esthétique | Vocabulaire métier + durées par prestation |
| 4 | Agenda | 🗓️ Google Calendar / Outlook | API ouvertes et documentées — intégration fiable |
| 5 | Profil porteur | 🎯 Business/vente, non technique | Technique 100 % déléguée ; documentation sans jargon |
| 6 | Méthode de build | ⚡ Plateforme voix managée (Vapi) + couche métier maison | Time-to-market en semaines, pas en mois |
| 7 | Langue | 🇫🇷 Français uniquement | Une seule voix, optimisée à fond |
| 8 | Délai | 🗓️ Quelques semaines, V1 propre | MVP solide, pas de bricolage jetable |
| 9 | Arrivée des appels | 🔀 Deux modes : débordement **et** standard complet | Argument de vente flexible selon le salon |
| 10 | Périmètre fonctionnel | Prendre + modifier/annuler + FAQ + message + transfert humain | L'agent ne laisse JAMAIS un appelant sans solution |
| 11 | Salon pilote | 🏗️ Aucun au départ → salon fictif « L'Atelier Coiffure » | La démo sert d'outil de prospection |
| 12 | Budget outils | 💶 50–200 €/mois en phase de construction | Largement suffisant (crédits d'essai au début) |
| 13 | Style du salon démo | Salon mixte coupe & couleur | Vocabulaire large = démo plus impressionnante |

## 2. Modèle économique visé

| Élément | Valeur | Détail |
|---|---|---|
| Coût réel d'un appel | ~0,10–0,20 € / minute | Téléphonie + reconnaissance vocale + IA + synthèse vocale |
| Volume type d'un salon | ~100 appels manqués/mois × 2 min | ≈ 20–40 €/mois de coût variable |
| Numéro de téléphone | ~1–2 €/mois par salon | |
| **Prix de vente cible** | **99–199 €/mois par salon** | Abonnement, sans engagement long au début |
| Marge brute estimée | ~60–80 % | Récurrente et duplicable |

**Argument de vente central :** un seul RDV « sauvé » par semaine (≈ 45 € de
panier moyen) rembourse déjà la moitié de l'abonnement. L'agent se paie tout seul.

## 3. Stack technique (et pourquoi chaque brique)

| Brique | Choix | Pourquoi |
|---|---|---|
| Plateforme voix (orchestration) | **Vapi** | Assemble téléphonie + STT + LLM + TTS avec une latence optimisée ; on configure, on ne recode pas |
| Cerveau (LLM) | **Claude Haiku 4.5** (`claude-haiku-4-5`) | Le plus rapide de la gamme Claude → indispensable au téléphone ; excellent en français |
| Cerveau (option qualité) | **Claude Sonnet 4.6** (`claude-sonnet-4-6`) | Si on veut plus de finesse de compréhension ; un peu plus lent et plus cher — à tester en Phase 3 |
| Reconnaissance vocale (STT) | **Deepgram nova-2, langue `fr`** | Très réactif, bon sur le français parlé au téléphone |
| Synthèse vocale (TTS) | **Cartesia Sonic** ou **ElevenLabs** | Voix françaises naturelles à faible latence ; on tranche à l'oreille en Phase 1 |
| Agenda | **Google Calendar API** | Branché en Phase 2 via les « tools » de l'agent |
| Téléphonie | Numéro via Vapi (ou Twilio importé) | Quelques clics, ~1–2 €/mois |

> Principe directeur : **chaque brique est remplaçable**. Si une voix meilleure
> sort demain, on change un réglage, pas le produit.

## 4. Ce qui fait le « premium » (nos critères qualité)
1. **Latence** : l'agent répond en moins d'une seconde, sans blanc gênant.
2. **Naturel** : phrases courtes, ton souriant, gestion des interruptions et hésitations.
3. **Fiabilité** : zéro invention (tarifs, horaires, dispos) ; reformulation systématique
   des noms, numéros et dates.
4. **Issue garantie** : chaque appel se termine par un RDV, une réponse, un message
   pris ou un transfert — jamais une impasse.
5. **Transparence** : l'agent se présente honnêtement comme assistant du salon
   (confiance client + conformité).

## 5. ⚠️ Conformité (RGPD + transparence IA) — traité en Phase 4
- Données manipulées : nom, téléphone, rendez-vous → **données personnelles**.
- À mettre en place avant la vente : information de l'appelant, base légale,
  durée de conservation, hébergement des données, registre de traitement.
- **Enregistrement des appels : désactivé par défaut** pendant les tests ;
  s'il est activé un jour, annonce vocale obligatoire en début d'appel.
- Transparence : l'agent ne nie jamais être une IA si on lui pose la question
  (réglementation européenne sur l'IA + simple bon sens commercial).
- Non bloquant pour la démo, **bloquant avant le premier client payant**.

## 6. Risques identifiés et parades

| Risque | Parade |
|---|---|
| Voix pas assez naturelle → effet « robot » | Tester 2-3 voix (Cartesia / ElevenLabs), itérer sur le prompt, ambiance sonore de fond optionnelle |
| Latence trop élevée | Claude Haiku 4.5 + Deepgram + réglages de fin de phrase (endpointing) |
| L'agent invente une dispo / un tarif | Garde-fous stricts dans le prompt + en Phase 2 l'agenda réel fait foi |
| Dépendance à Vapi | Briques remplaçables ; le prompt et la logique métier nous appartiennent |
| RGPD négligé | Checklist conformité obligatoire en Phase 4, avant tout client réel |
