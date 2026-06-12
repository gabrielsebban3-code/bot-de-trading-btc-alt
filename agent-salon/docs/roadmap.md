# 🗺️ Feuille de route — 6 phases

Légende : 🧑 = action du porteur (comptes, clics, tests au téléphone) · 🤖 = construction technique

Chaque phase a un **critère de réussite mesurable** : tant qu'il n'est pas
atteint, on ne passe pas à la suivante.

---

## Phase 0 — Fondations  `[EN COURS]`
> Préparer les comptes et la matière première.

- 🧑 Créer un compte Google dédié + un agenda « Salon Démo » → [guide pas à pas](guide-demarrage.md)
- 🧑 Créer un compte Vapi (crédits d'essai gratuits, **sans carte bancaire**)
- 🤖 Fiche du salon fictif + prestations/tarifs ✅
- 🤖 Personnalité de l'agent (system prompt) + config Vapi + protocole de test ✅

**✓ Critère de réussite :** les 2 comptes existent, tous les documents sont prêts.

---

## Phase 1 — « Il parle »
> Un agent qui décroche et tient une vraie conversation française.

- 🧑 Créer l'assistant dans Vapi en suivant [`config-vapi.md`](../agent/config-vapi.md) (copier-coller, ~30 min)
- 🧑 Attacher un numéro de téléphone et appeler
- 🧑 Dérouler le [protocole de test](../agent/checklist-test.md) et noter les résultats
- 🤖 Analyser les retours, affiner le prompt et les réglages voix (2-3 itérations)

**✓ Critère de réussite :** tu fais écouter l'appel à quelqu'un qui ne sait pas
que c'est une IA, et il met plus de 30 secondes à s'en douter. **Moment « waouh ».**

---

## Phase 2 — « Il réserve »
> Connexion réelle à l'agenda — le cœur de la valeur.

- 🤖 Brancher Google Calendar via les « tools » de l'agent :
  - lire les disponibilités réelles (en tenant compte de la durée de chaque prestation)
  - créer un rendez-vous (titre = prestation + nom du client + téléphone)
  - retrouver, déplacer et annuler un rendez-vous existant
- 🤖 Logique coiffure : durées par prestation, affectation par coiffeur (Sophie/Marc/Léa)
- 🧑 Tester : appeler, prendre un RDV, vérifier qu'il apparaît dans l'agenda

**✓ Critère de réussite :** 10 prises de RDV de suite au téléphone → 10 événements
corrects dans Google Calendar (bonne durée, bon coiffeur, bonnes coordonnées),
zéro double réservation.

---

## Phase 3 — « Il gère le réel »
> Robustesse et finition premium — l'agent encaisse l'imprévu.

- 🤖 Prise de message structurée + notification au salon (SMS ou email au gérant)
- 🤖 Transfert d'appel vers le portable du salon (cas sensibles)
- 🤖 Les deux modes d'accueil : débordement (l'IA ne décroche que si le salon ne répond pas)
  et standard complet (l'IA décroche tout)
- 🤖 Gestion des cas tordus : accents, bruit de fond, enfants, démarchage, client mécontent
- 🧑 Faire tester par 5-10 personnes différentes (« crash test » amical)

**✓ Critère de réussite :** sur 20 appels par des personnes différentes non briefées,
≥ 18 se terminent par une issue correcte (RDV, réponse, message ou transfert).

---

## Phase 4 — Industrialisation
> Rendre le produit vendable et duplicable.

- 🤖 « Template salon » : déployer un nouveau salon en < 30 min (fiche à remplir
  → prompt généré → agent en ligne)
- 🤖 Mini tableau de bord pour le gérant : RDV pris, messages, appels traités
- 🤖 Conformité RGPD complète (information, conservation, registre) + mentions de transparence IA
- 🤖 Suivi des coûts par salon (rentabilité visible)

**✓ Critère de réussite :** créer un 2e salon fictif de A à Z en moins de 30 minutes,
checklist RGPD 100 % verte.

---

## Phase 5 — Go-to-market
> Vendre.

- 🤖 Kit de vente : démo à faire écouter, argumentaire ROI (« un RDV sauvé par
  semaine rembourse la moitié de l'abonnement »), grille tarifaire
- 🧑 Prospection : commencer par ton propre coiffeur / contacts directs / salons
  qui ne décrochent pas quand tu les appelles (test grandeur nature !)
- 🧑 Premier salon pilote : gratuit ou à prix réduit 1 mois contre retours détaillés
- 🧑 Passage en abonnement payant

**✓ Critère de réussite :** premier client payant signé.
