# 📅 Phase 2 — Connecter Camille à l'agenda (le cœur de la valeur)

> Objectif : Camille **réserve, déplace et annule pour de vrai** dans Google
> Calendar. Aujourd'hui elle dit « c'est noté » mais rien ne s'écrit ; à la fin
> de cette phase, le rendez-vous apparaît réellement dans l'agenda.

## 🧠 Comment ça marche (en clair)
```
   Le client parle à Camille (Vapi)
            │
            │  quand elle doit voir une dispo ou poser un RDV,
            │  elle "appelle un outil"
            ▼
   Un PONT no-code (Make.com)
            │  reçoit la demande et parle à l'agenda
            ▼
   Google Agenda  ── lire / créer / déplacer / annuler
            │
            ▼
   La réponse revient à Camille, qui parle au client
```

## 🧩 Pourquoi un pont « no-code » (Make.com) plutôt que du code
- **Zéro serveur à héberger, zéro code à déployer** de ton côté.
- Connexion à ton Google Agenda **en un clic** (autorisation Google sécurisée).
- **Gratuit** pour nos volumes de test (~1000 opérations/mois offertes).
- On pourra le remplacer par un système **sur-mesure** en Phase 4 (industrialisation),
  pour la marque blanche et le passage à l'échelle. Pour l'instant : vitesse + simplicité.

## 🔧 Les 3 « outils » qu'on va donner à Camille
1. **`verifier_disponibilite`** — regarde les créneaux libres pour une prestation
   (en tenant compte de sa durée et du coiffeur).
2. **`creer_rendezvous`** — écrit le RDV dans l'agenda (titre = prestation + nom +
   téléphone), avec le bon coiffeur et la bonne durée.
3. **`annuler_ou_deplacer`** — retrouve un RDV existant et l'annule ou le déplace.

> On commencera probablement par **`creer_rendezvous` seul** (le premier effet
> « waouh » : voir le RDV apparaître), puis on ajoutera la vérification des
> disponibilités et l'annulation.

## ✅ Le truc malin : on teste SANS micro
La Phase 2, c'est de la **logique**, pas de la voix. On pourra donc la valider
entièrement via le mode **« Chat »** de Vapi (on écrit à Camille) : ça créera
quand même de **vrais événements** dans Google Agenda. **Le problème de micro ne
nous bloque pas du tout pour cette phase.** 🎉

## 🪜 Les étapes
### 🧑 TOI (création de comptes)
- Créer un compte **Make.com** (gratuit).
- Connecter ton compte **Google** (celui du « Salon Démo »).

### 🤖 MOI (construction)
- Concevoir le scénario Make (lire / créer / déplacer / annuler).
- Écrire les **définitions d'outils** exactes à coller dans Vapi.
- Mettre à jour le **system prompt** pour que Camille **utilise** ces outils au
  lieu de faire semblant.

### 🤝 ENSEMBLE
- Brancher le tout, puis tester : prendre un RDV (en Chat) → vérifier qu'il
  apparaît dans l'agenda, à la bonne heure, avec le bon coiffeur.

## 🎯 Critère de réussite
10 prises de RDV d'affilée → **10 événements corrects** dans Google Agenda
(bonne durée, bon coiffeur, bonnes coordonnées), **zéro double réservation**.

## 🗒️ Note — test vocal réel
Pour tester Camille en conditions réelles plus tard, on importera un **numéro
français** (via Twilio, ~1 €/mois) — l'audio téléphonique réglera le souci de
compréhension du micro navigateur. À faire après la Phase 2.
