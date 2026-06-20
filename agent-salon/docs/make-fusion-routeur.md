# 🔀 Fusion des scénarios Make : 3 → 2 (routeur)

> Objectif : passer de **3 scénarios** à **2**, tous les deux actifs (le plan
> gratuit autorise 2 actifs). On fusionne **Création + Disponibilité** en un seul
> scénario avec un **routeur**, et on garde **Annulation** séparé.

## 🧠 Le principe
Un appel de **prise de RDV** enchaîne 2 outils : `verifier_disponibilite` PUIS
`creer_rendezvous`. On les met donc dans **le même scénario** (1 webhook + un
routeur). L'annulation, qui est un appel à part, reste dans son propre scénario.

> ⚠️ **Leçon apprise (important) :** on a d'abord voulu router sur un champ
> `action` (envoyé en *Static Body Field* depuis Vapi). **Ça n'a pas marché** :
> ce champ statique n'arrive pas de façon fiable jusqu'au webhook Make (et le
> bouton « Test Tool » de Vapi ne l'envoie jamais). La solution **qui fonctionne**
> route sur la **présence du champ `nom_client`** : il n'est envoyé QUE par
> `creer_rendezvous`. `verifier_disponibilite`, lui, n'envoie que la date, la
> durée et le coiffeur — donc pas de `nom_client`.
>
> - `nom_client` **présent** → on **crée** le RDV
> - `nom_client` **absent**  → on **vérifie** la dispo

```
SCÉNARIO 1 « camille-rdv »  (ACTIF)
   1 Webhook (camille-rdv) → ROUTEUR (teste la présence de "nom_client")
        ├─ nom_client absent   → Search Events → Réponse {rdv_id}   (vérifier)
        └─ nom_client présent  → Create Event  → Réponse {result}   (créer)

SCÉNARIO 2 « camille anulation »  (ACTIF, inchangé)
   1 Webhook (camille-annulation) → Search → Delete → Réponse {result}
```

---

## PHASE 1 — Côté Vapi (1 seul outil à modifier ; les autres ne changent pas)

**`verifier_disponibilite`** :
1. Request URL → mets l'URL du webhook **`camille-rdv`** (la même que creer).
2. Save.

**`creer_rendezvous`** : URL déjà `camille-rdv`, **rien à changer** (le champ
`nom_client` qu'il envoie déjà sert de signal au routeur).

**`annuler_rendezvous`** : **on ne touche à rien** (reste sur `camille-annulation`).

> Pas besoin de champ `action` : on n'ajoute aucun Static Body Field. Le routeur
> se base sur `nom_client`, déjà présent dans `creer_rendezvous` et absent de
> `verifier_disponibilite`.

---

## PHASE 2 — Apprendre les champs au webhook
1. Ouvre le scénario **camille-rdv** → clique **Re-determine data structure** sur
   le webhook (laisse la fenêtre ouverte).
2. Déclenche un vrai appel (ou un Test Tool) pour que le webhook apprenne les
   champs, dont **`nom_client`** — c'est lui qui pilote le routeur.

---

## PHASE 3 — Côté Make : ajouter le routeur dans « Camille - RDV »
On part du scénario **Création** (renomme-le **« Camille - RDV »**).
Actuel : `Webhook → Create an Event → Webhook Response`.

### 3.1 Insérer le routeur
1. **Supprime le lien** entre le Webhook et « Create an Event ».
2. Depuis la sortie du Webhook → ajoute **Flow Control → Router**.
3. Relie le routeur à l'ancien **Create an Event** (= 1re route, déjà prête).

### 3.2 Branche CREER (existante)
- Filtre sur la route → Create an Event : `nom_client` **Exists** (catégorie
  *Basic operators*, pas de valeur à saisir).
- Modules inchangés. Réponse (Webhook Response) :
  `{"result": "Le rendez-vous a bien été enregistré dans l'agenda."}`
  avec le header `Content-Type: application/json` — **sinon Vapi affiche
  « invalid json response body »** même si le RDV est bien créé.

### 3.3 Branche VERIFIER (nouvelle)
- Nouvelle route du routeur, filtre : `nom_client` **Does not exist** (catégorie
  *Basic operators*).
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
1. Active **`camille-rdv`** et **`camille anulation`** (les 2 ON).
2. Désactive l'ancien scénario **`dispo camille`** (son rôle est maintenant dans
   `camille-rdv`). On le garde en OFF par sécurité avant de le supprimer.
3. **Teste avec de VRAIS appels**, pas le bouton « Test Tool » de Vapi (il
   n'envoie pas tout, donc il fausse le test) :
   - Prendre un RDV → doit apparaître dans Google Calendar, sans erreur rouge.
   - Redemander le **même créneau** → Camille doit dire que c'est pris (route
     VERIFIER).
   - Annuler → le RDV disparaît de l'agenda.

## 🩺 Pannes rencontrées et corrigées
| Symptôme | Cause | Correctif |
|---|---|---|
| Filtres « ⊘ 0 », rien ne passe | champ `action` jamais reçu par Make | router sur `nom_client` (Exists / Does not exist) |
| `invalid json response body` côté Vapi | Make répond en texte brut | Webhook Response avec body JSON + header `Content-Type: application/json` |
| RDV créé mais erreur rouge quand même | header JSON manquant sur la réponse | ajouter le header `Content-Type: application/json` |

## ✅ Résultat
2 scénarios actifs gèrent tout. Un appel complet (vérifier la dispo PUIS réserver)
passe par le seul scénario `camille-rdv`. Prêt pour la démo de vente.
