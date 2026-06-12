# 🤖 Agent IA téléphonique pour salons de coiffure

Assistant vocal qui **décroche le téléphone à la place du salon**, parle français
comme un humain, et **prend / modifie / annule les rendez-vous** directement dans
l'agenda. Produit pensé pour être **vendu en abonnement mensuel** à des salons.

---

## 📌 Le produit en une phrase
> Un standardiste téléphonique IA premium pour salons de coiffure : il décroche,
> comprend, réserve dans Google Calendar, répond aux questions, prend un message
> ou transfère à un humain quand il faut. Le salon ne perd plus jamais un client
> faute d'avoir décroché.

## 🎯 Positionnement
- **Marché n°1 :** coiffeurs / barbiers / esthétique (gros volume d'appels, RDV courts)
- **Canal :** voix — appels téléphoniques entrants
- **Langue :** français, voix ultra-naturelle (le critère premium n°1)
- **Agenda :** Google Calendar / Outlook
- **Modèle économique :** abonnement mensuel par salon (cible 99–199 €/mois),
  coût réel ~0,10–0,20 €/min d'appel → marge récurrente

## 🧱 Stratégie technique
On construit **par-dessus une plateforme voix managée (Vapi)** : la téléphonie,
la reconnaissance vocale et la synthèse vocale sont des briques déjà excellentes.
**Notre valeur ajoutée = le cerveau** : la personnalité premium, la logique métier
coiffure, la connexion à l'agenda, et la duplication rapide d'un salon à l'autre.

## 🗺️ Où en est-on ?
Feuille de route complète : [`docs/roadmap.md`](docs/roadmap.md) — 6 phases.
**Phase en cours : 0 → 1** (faire parler l'agent).
**Prochaine action côté porteur :** créer les 2 comptes — voir
[`docs/guide-demarrage.md`](docs/guide-demarrage.md).

## 📂 Contenu du dossier
```
agent-salon/
├── README.md                ← tu es ici
├── docs/
│   ├── cadrage.md           ← toutes les décisions du projet (source de vérité)
│   ├── roadmap.md           ← les 6 phases, avec critères de réussite
│   └── guide-demarrage.md   ← TES actions pas à pas (comptes, clics, tests)
├── salon-demo/
│   ├── fiche-salon.md       ← le salon fictif « L'Atelier Coiffure » (identité, équipe, FAQ)
│   └── prestations.md       ← prestations, durées et tarifs
└── agent/
    ├── system-prompt.md     ← LE CERVEAU : personnalité + règles + scénarios
    ├── config-vapi.md       ← réglages exacts à reproduire dans Vapi
    └── checklist-test.md    ← le protocole de test au téléphone (Phase 1)
```

## 🔐 Règles du projet
- **Aucune clé API, aucun mot de passe** ne doit jamais être enregistré dans ce dépôt.
- Le porteur reste **propriétaire de tous les comptes** (Google, Vapi, téléphonie).
- Conformité **RGPD** intégrée avant toute mise en production (Phase 4).
