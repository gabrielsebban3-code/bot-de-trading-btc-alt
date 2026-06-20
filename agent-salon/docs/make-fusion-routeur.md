# 🔀 Fusion des scénarios Make : 3 → 2 (routeur)

> Objectif : passer de **3 scénarios** à **2**, tous les deux actifs (le plan
> gratuit autorise 2 actifs). On fusionne **Création + Disponibilité** en un seul
> scénario avec un **routeur**, et on garde **Annulation** séparé.

## 🧠 Le principe
Un appel de **prise de RDV** enchaîne 2 outils : `verifier_disponibilite` PUIS
`creer_rendezvous`. On les met donc dans **le même scénario** (1 webhook + un
routeur sur le champ `action`). L'annulation, qui est un appel à part, reste dans
son propre scénario.

```
SCÉNARIO 1 « Camille - RDV »  (ACTIF)
   1 Webhook (camille-rdv) → ROUTEUR (lit "action")
        ├─ action = verifier → Search Events → Réponse {rdv_id}
        └─ action = creer    → Create Event  → Réponse {result}

SCÉNARIO 2 « Camille - Annulation »  (ACTIF, inchangé)
   1 Webhook (camille-annulation) → Search → Delete → Réponse {result}
```

---

## PHASE 1 — Côté Vapi (2 outils à modifier ; annuler ne change pas)

**`verifier_disponibilite`** :
1. Request URL → mets l'URL du webhook **`camille-rdv`** (la même que creer).
2. Static Body Fields → Add Field : Key `action`, Value `verifier`.
3. Save.

**`creer_rendezvous`** :
1. URL déjà `camille-rdv` (ne change pas).
2. Static Body Fields → Add Field : Key `action`, Value `creer`.
3. Save.

**`annuler_rendezvous`** : **on ne touche à rien** (reste sur `camille-annulation`).

---

## PHASE 2 — Apprendre le champ `action` au webhook
1. Ouvre le scénario **Création** → clique **Detect new values** sur le webhook.
2. Envoie un test depuis `creer_rendezvous` (Test Tool), puis un depuis
   `verifier_disponibilite`. Le webhook apprend `action` + tous les champs.

---

## PHASE 3 — Côté Make : ajouter le routeur dans « Camille - RDV »
On part du scénario **Création** (renomme-le **« Camille - RDV »**).
Actuel : `Webhook → Create an Event → Webhook Response`.

### 3.1 Insérer le routeur
1. **Supprime le lien** entre le Webhook et « Create an Event ».
2. Depuis la sortie du Webhook → ajoute **Flow Control → Router**.
3. Relie le routeur à l'ancien **Create an Event** (= 1re route, déjà prête).

### 3.2 Branche CREER (existante)
- Filtre sur la route → Create an Event : `action` **Equal to** `creer`.
- Modules inchangés. Réponse : `{"result": "Le rendez-vous a bien été enregistré dans l'agenda."}`

### 3.3 Branche VERIFIER (nouvelle)
- Nouvelle route du routeur, filtre : `action` **Equal to** `verifier`.
- Module 1 : **Google Calendar → Search Events**
  - Calendar ID : `gabrielagent3@gmail.com`
  - Query : **(vide)**
  - Start Date : `{{parseDate(1.date_heure_debut; "YYYY-MM-DDTHH:mm")}}`
  - End Date : `{{addMinutes(parseDate(1.date_heure_debut; "YYYY-MM-DDTHH:mm"); 1.duree_minutes)}}`
  - Single Events : `Yes` · Limit : `10`
- Module 2 : **Webhook Response**
  - Body : `{"rdv_id": "{{<Event ID de Search Events>}}"}`
  - Header : `Content-Type: application/json`

> 💡 Astuce gain de temps : ces 2 modules existent déjà dans le scénario
> « Disponibilité ». Tu peux les **copier-coller** (clic droit → Copy) dans la
> nouvelle branche, puis re-vérifier les mappings de dates.

---

## PHASE 4 — Activer et tester
1. Active **« Camille - RDV »** et **« Camille - Annulation »** (les 2 ON).
2. Désactive / supprime l'ancien scénario **« Disponibilité »** (son rôle est
   maintenant dans « Camille - RDV »).
3. Teste les 3 actions (Run once + Test Tool de chaque outil).

## ✅ Résultat
2 scénarios actifs gèrent tout. Un appel complet (vérifier la dispo PUIS réserver)
passe par le seul scénario « Camille - RDV ». Prêt pour la démo de vente.
