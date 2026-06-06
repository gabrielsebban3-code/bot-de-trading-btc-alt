# 🤖 Bot de Signaux Trading — SMC (Smart Money Concepts)

Bot Python qui surveille en continu les marchés **Binance Futures** et envoie
des alertes **Discord** dès qu'une opportunité **LONG** ou **SHORT** à forte
probabilité est détectée, avec niveaux précis d'**entrée, Stop Loss et 3 Take
Profits** basés sur la structure SMC.

> ⚠️ **Avertissement** : cet outil est fourni à titre éducatif. Ce ne sont pas
> des conseils financiers. Le trading de cryptomonnaies comporte des risques de
> perte en capital. Teste toujours et trade à tes propres risques.

---

## 🧠 Comment ça marche

### Paires surveillées (13)
Top 10 par capitalisation + 3 ajouts, en perpétuels USDT :
`BTC, ETH, XRP, BNB, SOL, DOGE, ADA, TRX, LINK, AVAX` + `ASTR, HYPE, ONDO`.

### Confluence multi-timeframe
| TF | Rôle |
|----|------|
| **1D** | Biais macro (structure haussière / baissière) |
| **4H** | Tendance intermédiaire + zones Order Block / FVG |
| **1H** | Confirmation d'entrée + détection BOS / CHOCH |
| **15m** | Timing d'entrée + affinage du SL |

Un signal n'est valide que si **au moins 3 des 4 timeframes** sont alignés dans
la même direction.

### Indicateurs
- **SMC** : Order Blocks, Fair Value Gaps, BOS, CHOCH, sweeps de liquidité
  (equal highs/lows à 0.15 % près)
- **EMA** 21 / 50 / 200 (filtre de tendance sur 1H et 4H)
- **RSI 14** (plages de momentum + divergences)
- **Volume** (spike > 1.5× la moyenne 20 périodes)
- **ATR 14** (classification de volatilité Low / Medium / High — contextuel)

### Score de confluence /6
Un signal est émis si le score atteint le seuil (`MIN_CONFLUENCE_SCORE`, 4 par
défaut) **et** que ≥ 3/4 timeframes sont alignés.

### Anti-spam
Pas de re-signal pour la même **paire + direction** pendant **4 heures**.

---

## 📂 Structure

```
trading-bot/
├── main.py           # Point d'entrée, boucle de scan (toutes les 5 min)
├── indicators.py     # Tous les calculs TA (OB, FVG, BOS, EMA, RSI, ATR, Volume)
├── signals.py        # Détection des signaux + scoring + SL/TP
├── discord_alert.py  # Construction et envoi de l'embed Discord
├── config.py         # Paires, timeframes, seuils (TOUT est éditable ici)
├── Dockerfile
├── fly.toml
├── .dockerignore
├── .env.example      # Modèle ; copie en .env
├── requirements.txt
└── README.md
```

---

## 🧪 1. Installation locale (pour tester uniquement)

> Le bot est conçu pour tourner **dans le cloud 24/7** (voir section Fly.io).
> L'installation locale sert seulement aux tests.

```bash
cd trading-bot
python -m venv .venv
source .venv/bin/activate         # Windows : .venv\Scripts\activate
pip install -r requirements.txt
```

## 🔑 2. Configurer le `.env`

```bash
cp .env.example .env
```

Édite `.env` :
```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxx/yyyy
BINANCE_API_KEY=        # optionnel (lecture seule), laisse vide si non utilisé
BINANCE_API_SECRET=
```

**Créer un webhook Discord** : Paramètres du salon → *Intégrations* →
*Webhooks* → *Nouveau webhook* → copie l'URL.

## ▶️ 3. Lancer en local (test)

```bash
python main.py
```

La console affiche, à chaque cycle : horodatage, paire scannée, et résultat
(`signal` / `pas de signal`). Les alertes sont aussi écrites dans `alerts.log`.

## ✏️ 4. Ajouter / retirer des paires

Tout se passe dans `config.py`, liste `PAIRS` :

```python
PAIRS = [
    "BTC/USDT",
    "ETH/USDT",
    # ... ajoute ou commente une ligne ...
    "ONDO/USDT",
]
```

Tu peux aussi y ajuster les seuils (RSI, volume, ATR, RR des TP, cooldown, etc.).

---

## ☁️ 5. Déployer sur Fly.io (24/7, sans spin-down)

### a. Installer flyctl
```bash
# macOS / Linux
curl -L https://fly.io/install.sh | sh
# Windows (PowerShell)
# pwsh -Command "iwr https://fly.io/install.sh -useb | iex"

fly auth signup   # ou : fly auth login
```

### b. Initialiser l'app (sans déployer tout de suite)
Depuis le dossier `trading-bot/` :
```bash
fly launch --no-deploy
```
- Réutilise le `fly.toml` fourni (réponds **non** si on te propose d'en générer
  un nouveau qui écraserait celui-ci, ou édite le nom de l'app après coup).
- N'ajoute **pas** de base de données ni de service HTTP : c'est un worker.

### c. Définir les secrets (jamais committés)
```bash
fly secrets set DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/xxxx/yyyy"
# Optionnel :
fly secrets set BINANCE_API_KEY="..." BINANCE_API_SECRET="..."
```

### d. Déployer
```bash
fly deploy
```

### e. Garder une machine toujours allumée
```bash
fly scale count 1
```
Comme l'app n'expose **aucun service HTTP**, Fly ne met pas la machine en veille
sur inactivité réseau : le bot tourne donc en continu. La boucle de scan
redémarre automatiquement avec le conteneur en cas de restart.

### f. Vérifier les logs
```bash
fly logs
```

---

## 🐳 Portable sur n'importe quel hôte Docker

Le `Dockerfile` est standard (`python:3.11-slim`) : le bot tourne aussi sur
**Railway**, **Render** (Background Worker), un **VPS**, etc.

```bash
docker build -t trading-bot .
docker run -d --env-file .env --name trading-bot trading-bot
```

Sur Railway / Render : déploie le repo, définis les variables d'environnement
(`DISCORD_WEBHOOK_URL`, etc.) dans le dashboard, et choisis le type
**Worker / Background** (pas de port web).

---

## 🛡️ Robustesse
- Toutes les erreurs API sont attrapées et loguées — la boucle ne crashe jamais.
- Rate-limit Binance → attente 10 s puis retry.
- Échec webhook Discord → log + on continue.
- Logs console **et** fichier `alerts.log`.
