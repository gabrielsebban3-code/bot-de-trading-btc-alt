# 🤖 Agent IA téléphonique pour salons de coiffure

Assistant vocal qui **décroche le téléphone à la place du salon**, parle français
comme un humain, et **prend / modifie / annule les rendez-vous** directement dans
l'agenda. Produit pensé pour être **vendu en abonnement mensuel** à des salons.

---

## 📌 Le produit en une phrase
> Un standardiste téléphonique IA premium pour salons de coiffure : il décroche,
> comprend, réserve dans Google Calendar, répond aux questions, prend un message
> ou transfère à un humain quand il faut.

## 🎯 Cible
- **Marché n°1 :** coiffeurs / barbiers / esthétique
- **Canal :** voix (appels téléphoniques)
- **Langue :** français
- **Agenda :** Google Calendar / Outlook

## 🧱 Stratégie technique
On construit **par-dessus une plateforme voix managée** (Vapi) pour aller vite et
garder une qualité premium. Notre valeur ajoutée = **le cerveau** (personnalité,
logique coiffure, connexion agenda, ton premium).

## 🗺️ Où en est-on ?
Voir [`docs/roadmap.md`](docs/roadmap.md) — feuille de route en 6 phases.
**Phase en cours : 0 → 1** (faire parler l'agent).

## 📂 Contenu du dossier
```
agent-salon/
├── README.md                ← tu es ici
├── docs/
│   ├── cadrage.md           ← toutes les décisions du projet (référence)
│   └── roadmap.md           ← les 6 phases du projet
├── salon-demo/
│   ├── fiche-salon.md       ← le salon fictif de démo (infos, équipe, horaires)
│   └── prestations.md       ← prestations, durées et tarifs
└── agent/
    ├── system-prompt.md     ← LE CERVEAU : personnalité + règles de l'agent
    ├── config-vapi.md       ← réglages exacts à coller dans Vapi
    └── checklist-test.md    ← 10 tests à faire au téléphone (Phase 1)
```
