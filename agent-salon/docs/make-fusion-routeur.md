# 🔀 Fusion des scénarios Make en UN seul (routeur)

> Objectif : un **seul** scénario Make qui gère les 3 actions (créer, annuler,
> vérifier la dispo) grâce à un **routeur**. Un seul scénario actif → tient dans
> le plan gratuit, et **1 scénario = 1 salon** quand tu vendras (ça passe à
> l'échelle).

## 🧠 Le principe
Les 3 outils Vapi envoient tous au **même webhook**, mais chacun ajoute un champ
**`action`** (`creer`, `annuler`, `verifier`). Un **routeur** lit ce champ et
aiguille vers la bonne branche.

```
            ┌──────────────────────────────────────────────┐
1 Webhook → │  ROUTEUR (lit le champ "action")             │
            │     ├─ action = verifier → Search → Réponse   │
            │     ├─ action = creer    → Create → Réponse   │
            │     └─ action = annuler  → Search → Delete → Réponse
            └──────────────────────────────────────────────┘
```

---

## PHASE 1 — Côté Vapi : 1 seule URL + le champ `action`

On choisit **un seul webhook** (celui de la Création, `camille-rdv`) comme point
d'entrée unique. On y branche les 3 outils.

Pour **chacun des 3 outils** (`creer_rendezvous`, `annuler_rendezvous`,
`verifier_disponibilite`) :
1. **Request URL** → mets l'URL du webhook **`camille-rdv`** (la même pour les 3).
2. Section **Static Body Fields** → **Add Field** :
   - `creer_rendezvous`    → Key `action`, Value `creer`
   - `annuler_rendezvous`  → Key `action`, Value `annuler`
   - `verifier_disponibilite` → Key `action`, Value `verifier`
3. **Save** chaque outil.

> Les paramètres existants (nom_client, date_heure_debut…) ne changent pas. On
> ajoute juste `action` en valeur fixe.

---

## PHASE 2 — Côté Make : routeur + 3 branches

On part du scénario **Création** (renomme-le **« Camille - Tout »**). Il contient
déjà `Webhook → Create an Event → Webhook Response`.

### 2.1 Insérer le routeur
1. **Supprime le lien** entre le Webhook et « Create an Event » (clic droit sur la
   ligne → Delete, ou survole et supprime).
2. Depuis la sortie du **Webhook**, ajoute **Flow Control → Router**.
3. Relie une sortie du routeur à l'ancien **Create an Event** (cette branche existe
   déjà, on la garde).

### 2.2 Branche CREER (la branche existante)
- Sur le lien routeur → Create an Event, mets un **filtre** :
  - Condition : `action` (de Webhook) **Equal to** `creer`
- Modules (déjà configurés) : `Create an Event → Webhook Response`
- Réglages Create an Event (rappel) :
  - Calendar ID : `gabrielagent3@gmail.com`
  - Event Name : `{{1.prestation}} - {{1.nom_client}}`
  - Start Date : `{{1.date_heure_debut}}`
  - End Date : `{{addMinutes(parseDate(1.date_heure_debut; "YYYY-MM-DDTHH:mm"); 1.duree_minutes)}}`
  - Description : `Coiffeur : {{1.coiffeur}} | Tél : {{1.telephone}}`
- Webhook Response : `{"result": "Le rendez-vous a bien été enregistré dans l'agenda."}`

### 2.3 Branche VERIFIER (nouvelle)
- Nouvelle route du routeur, **filtre** : `action` **Equal to** `verifier`
- Module 1 : **Google Calendar → Search Events**
  - Calendar ID : `gabrielagent3@gmail.com`
  - Query : **(vide)**
  - Start Date : `{{parseDate(1.date_heure_debut; "YYYY-MM-DDTHH:mm")}}`
  - End Date : `{{addMinutes(parseDate(1.date_heure_debut; "YYYY-MM-DDTHH:mm"); 1.duree_minutes)}}`
  - Single Events : `Yes` · Limit : `10`
- Module 2 : **Webhook Response**
  - Body : `{"rdv_id": "{{<Event ID de Search Events>}}"}`
  - Header : `Content-Type: application/json`

### 2.4 Branche ANNULER (nouvelle)
- Nouvelle route du routeur, **filtre** : `action` **Equal to** `annuler`
- Module 1 : **Google Calendar → Search Events**
  - Calendar ID : `gabrielagent3@gmail.com`
  - Query : `{{1.nom_client}}`
  - Start Date : `{{parseDate(1.date_recherche; "YYYY-MM-DD")}}`
  - End Date : `{{addDays(parseDate(1.date_recherche; "YYYY-MM-DD"); 1)}}`
  - Single Events : `Yes` · Limit : `1`
- Module 2 : **Google Calendar → Delete an Event**
  - Event ID : `{{<Event ID de Search Events de cette branche>}}`
- Module 3 : **Webhook Response**
  - Body : `{"result": "Le rendez-vous a bien été annulé."}`

---

## PHASE 3 — Réapprendre les données + tester
1. Le webhook doit « apprendre » le champ `action` : clique **Detect new values**
   sur le webhook, puis envoie un test depuis Vapi (n'importe quel outil).
2. Active **« Camille - Tout »** (ON). Désactive les 2 anciens scénarios
   (Création / Disponibilité / Annulation séparés) — ils sont remplacés.
3. Teste les 3 actions une par une (Run once + Test Tool de chaque outil).

## ✅ Résultat
Un seul scénario actif gère tout. Un appel complet (vérifier la dispo PUIS
réserver) fonctionne, et tu peux enregistrer ta démo de vente.

## 🗑️ Nettoyage
Une fois « Camille - Tout » validé, tu peux supprimer les 3 anciens scénarios
séparés pour ne pas t'emmêler.
