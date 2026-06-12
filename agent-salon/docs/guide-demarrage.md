# 🚀 Guide de démarrage — TES actions, pas à pas

Ce document liste **uniquement ce que TOI tu dois faire**, dans l'ordre, clic
par clic. Aucune compétence technique requise. Temps total : **~30 minutes**.

> 💡 Règle d'or : tu crées les comptes **toi-même**, avec **ton** adresse email.
> Tu restes propriétaire de tout. Tu ne partages jamais un mot de passe — au
> moment voulu (Phase 2), on utilisera des « clés API », c'est prévu et encadré.

---

## ✅ Action 1 — Créer le compte Google dédié au projet (~10 min)

Pourquoi : c'est l'agenda de notre salon de test. En Phase 2, les rendez-vous
pris au téléphone s'écriront dedans, sous tes yeux.

1. Va sur **accounts.google.com** → « Créer un compte » → « Pour le travail ».
2. Choisis une adresse dédiée au projet, par exemple : `atelier.coiffure.demo@gmail.com`
   *(peu importe le nom exact — l'important est de ne PAS mélanger avec ton compte perso)*.
3. Note le mot de passe dans ton gestionnaire de mots de passe habituel.
4. Va sur **calendar.google.com** (connecté avec ce nouveau compte).
5. Dans la colonne de gauche → « Autres agendas » → **+** → « Créer un agenda ».
6. Nom : **Salon Démo** → « Créer l'agenda ».

☑️ **C'est réussi si :** tu vois un agenda vide nommé « Salon Démo » dans Google Calendar.

---

## ✅ Action 2 — Créer le compte Vapi (~10 min)

Pourquoi : Vapi est la « centrale téléphonique IA » sur laquelle on construit.
Elle fournit le numéro, l'oreille (reconnaissance vocale) et la bouche (voix de
synthèse) de l'agent. Nous, on fournit le cerveau.

1. Va sur **vapi.ai** → « Sign up ».
2. Inscris-toi (tu peux utiliser le compte Google créé à l'Action 1 — pratique,
   tout le projet reste au même endroit).
3. Tu arrives sur le « Dashboard » (tableau de bord). Tu reçois automatiquement
   des **crédits d'essai gratuits** (~10 $) — largement assez pour toute la Phase 1.
4. **NE METS PAS de carte bancaire.** On reste en essai gratuit tant que l'agent
   ne parle pas parfaitement.

☑️ **C'est réussi si :** tu vois le tableau de bord Vapi avec tes crédits d'essai.

---

## ✅ Action 3 — Me dire « comptes créés »

Dès que les Actions 1 et 2 sont faites, dis-le-moi. On enchaîne immédiatement
sur la **Phase 1** : je te guide écran par écran dans Vapi avec le document
[`config-vapi.md`](../agent/config-vapi.md) (tout est en copier-coller), et
**30 minutes plus tard tu appelles ton agent au téléphone**.

---

## 📞 Aperçu de la Phase 1 (pour savoir où on va)

| Étape | Quoi | Durée |
|---|---|---|
| 1 | Créer l'« Assistant » dans Vapi et lui donner un nom | 2 min |
| 2 | Coller le cerveau (system prompt) — fourni, copier-coller | 3 min |
| 3 | Choisir le modèle d'IA + la voix française + la reconnaissance vocale (réglages fournis) | 10 min |
| 4 | Attacher un numéro de téléphone | 5 min |
| 5 | **Appeler ton agent** 🎉 puis dérouler la [checklist de test](../agent/checklist-test.md) | 10 min |
| 6 | M'envoyer tes notes → j'affine → on recommence jusqu'au rendu parfait | itératif |

---

## ❓ Questions fréquentes

**Est-ce que ça va me coûter de l'argent ?**
Non, pas en Phase 1 : les crédits d'essai Vapi couvrent tout. Ensuite, compte
~0,10–0,20 € par minute d'appel de test — ton budget de 50–200 €/mois couvre
très largement les phases 2 et 3.

**Et si je me trompe quelque part ?**
Rien n'est irréversible. Au pire on supprime l'assistant et on le recrée en
5 minutes. Tu ne peux rien « casser ».

**Pourquoi pas Doctolib/Planity directement ?**
Leurs API sont fermées aux tiers. Google Calendar est ouvert, fiable, et la
plupart des petits salons s'en contentent très bien. Les intégrations métier
viendront plus tard, si le marché les exige.
