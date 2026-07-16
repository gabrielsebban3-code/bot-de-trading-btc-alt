# 🔧 Guide d'installation de Camille chez un nouveau client

> Objectif : à chaque salon signé, savoir exactement quoi faire pour mettre
> Camille en service. Compter **~30-45 min par salon**.

## 🧠 Le principe
Chaque salon a **SA propre Camille**, branchée sur **SON agenda Google** et **SON
numéro**. On ne partage jamais une Camille entre deux salons.

Un client a besoin de 4 choses à lui :
1. Son assistant Vapi (Camille personnalisée)
2. Son agenda Google (les RDV vont chez lui)
3. Son numéro de téléphone
4. Le renvoi d'appel activé sur son téléphone

---

## Étape 1 — Dupliquer et personnaliser Camille (Vapi)
1. Vapi → ton assistant Camille → **Duplicate**.
2. Renomme : **« Camille – [Nom du salon] »**.
3. Édite le **System Prompt** avec les infos DU salon :
   - Nom, adresse, arrondissement/ville
   - Horaires d'ouverture
   - Équipe (prénoms + spécialités)
   - Prestations + durées + tarifs
   - Le **premier message** (« [Salon], bonjour ! Je suis Camille… »)
4. Garde la même **voix (Cartesia FR)** et le même **transcripteur (Deepgram nova-3, langue Français)** — c'est ce qui marche.

---

## Étape 2 — Créer / choisir l'agenda du salon
- **Idéal :** dans le **compte Google du salon**, utiliser (ou créer) un agenda
  dédié aux RDV. Le salon reste **propriétaire de ses données** et voit tout.
- **S'ils n'ont pas de Google :** créer un agenda « RDV [Salon] » et le leur
  partager (ils installent l'appli Google Agenda sur leur téléphone).
- Note le **Calendar ID** (identifiant de l'agenda) — il servira dans Make.

---

## Étape 3 — Brancher Make sur cet agenda
1. **Duplique** tes 2 scénarios (`Camille - RDV` et `Camille - Annulation`).
2. Dans chaque module Google Calendar, remplace le **Calendar ID** par celui du salon.
3. Dans Vapi, relie les **outils** de la nouvelle Camille aux **nouveaux webhooks**
   (URL des scénarios dupliqués).
4. Teste chaque scénario (Run once + vrai appel).

> ⚠️ **Limite Make gratuit = 2 scénarios actifs.** Dès le 1er client payant :
> - **Recommandé :** passer Make en **payant** (~9 €/mois) → largement rentable
>   à 99-199 €/mois par client.
> - **Alternative gratuite :** un **compte Make gratuit par client** (2 scénarios
>   chacun), au prix de jongler avec plusieurs comptes.

---

## Étape 4 — Numéro de téléphone (Twilio)
- Achète / assigne un numéro Twilio et **attache-le à la Camille du salon** dans Vapi.

---

## Étape 5 — Renvoi d'appel (le cœur de la valeur)
Le salon **garde son numéro habituel**. On configure son téléphone pour basculer
les appels manqués vers le numéro de Camille.

**Mobile** (3 codes à taper, remplace `<CAMILLE>` par le numéro Twilio) :
- Pas de réponse après 20 s : `**61*<CAMILLE>**20#`
- Occupé : `**67*<CAMILLE>#`
- Éteint / hors réseau : `**62*<CAMILLE>#`

**Ligne fixe / box** : via l'espace client de l'opérateur (Freebox, Orange, SFR,
Bouygues) → « Renvoi d'appel sur non-réponse » → numéro de Camille.

---

## Étape 6 — Test final (devant le client)
1. Appeler le **numéro habituel du salon** depuis un autre téléphone.
2. Laisser sonner sans décrocher ~20 s.
3. **Camille répond** → prendre un RDV → vérifier qu'il apparaît dans **leur** agenda. ✅

---

## ✅ Checklist rapide
- [ ] Camille dupliquée + personnalisée (Vapi)
- [ ] Transcripteur : Deepgram **nova-3**, langue **Français**
- [ ] Agenda du salon prêt (Calendar ID noté)
- [ ] 2 scénarios Make dupliqués + Calendar ID changé
- [ ] Outils Vapi reliés aux nouveaux webhooks
- [ ] Numéro Twilio attaché
- [ ] Renvoi d'appel activé sur le téléphone du salon
- [ ] Appel de test réussi → RDV dans l'agenda du salon

---

## 🚀 Plus tard : la version « pro » (multi-tenant)
Quand tu auras 2-3 clients, on construira l'architecture scalable : **2 scénarios
Make pour TOUS les clients**, où l'agenda est choisi automatiquement (l'ID de
l'agenda est envoyé par Vapi et Make écrit dans le bon calendrier). Résultat : un
nouveau client = juste une Camille + un partage d'agenda + un numéro, sans
retoucher Make. C'est la base de la future interface web.
