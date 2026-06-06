# 🚀 GUIDE COMPLET DE A À Z — Faire tourner ton bot Discord en externe (24/7)

Ce guide t'explique **tout**, étape par étape, en partant de zéro, pour que ton
bot Python tourne **tout seul dans le cloud**, **24h/24 et 7j/7**, même quand ton
ordinateur est éteint.

> 👶 Guide pensé pour débutant : chaque commande est expliquée. Suis les étapes
> **dans l'ordre**, ne saute rien.

---

## 📑 SOMMAIRE

1. [Comprendre le principe](#1)
2. [Corriger LE bug qui fait planter ton bot](#2)
3. [Préparer ton dossier de bot proprement](#3)
4. [Mettre tes secrets dans un fichier `.env`](#4)
5. [Tester une dernière fois en local](#5)
6. [Choisir l'hébergeur (Railway recommandé)](#6)
7. [DÉPLOIEMENT A — Railway (le plus simple)](#7)
8. [DÉPLOIEMENT B — Fly.io (alternative)](#8)
9. [Vérifier que ça tourne + voir les logs](#9)
10. [Questions fréquentes / dépannage](#10)

---

<a name="1"></a>
## 1. 🧠 Comprendre le principe

Aujourd'hui ton bot tourne dans la fenêtre `cmd.exe` de ton PC. **Si tu fermes la
fenêtre ou éteins le PC → le bot s'arrête.**

Pour qu'il tourne **24/7**, il faut le mettre sur un **serveur dans le cloud** qui
ne s'éteint jamais. On va :

1. Mettre ton code dans un dossier propre.
2. Mettre tes mots de passe / clés (token Discord, etc.) dans des **variables
   secrètes** (jamais dans le code).
3. Envoyer le tout sur un hébergeur gratuit (**Railway** ou **Fly.io**).
4. L'hébergeur fait tourner ton bot en permanence.

---

<a name="2"></a>
## 2. 🐞 Corriger LE bug qui fait planter ton bot

Sur ta capture, il y a cette erreur :
```
RuntimeError: Task is already launched and is not completed.
File "bot_btc_court.py", line 276, in on_ready
    analyze_loop.start()
```

**Pourquoi ?** Discord appelle `on_ready` **à chaque reconnexion** (tu vois
« Shard ID None has successfully RESUMED session » dans tes logs). À chaque fois,
ton code refait `analyze_loop.start()` → mais la boucle tourne déjà → erreur.

Dans le cloud, le bot se reconnecte souvent → cette erreur reviendrait sans arrêt.

### ✅ La correction

Ouvre `bot_btc_court.py` et trouve ta fonction `on_ready`. Elle ressemble
sûrement à ça :

```python
@client.event
async def on_ready():
    print(f"Connecté en tant que {client.user}")
    analyze_loop.start()        # ❌ plante à la 2e reconnexion
```

Remplace par ceci (on vérifie que la boucle ne tourne pas déjà) :

```python
@client.event
async def on_ready():
    print(f"Connecté en tant que {client.user}")
    if not analyze_loop.is_running():   # ✅ on ne lance qu'une seule fois
        analyze_loop.start()
```

C'est la **seule ligne importante** à corriger. Enregistre le fichier.

> 💡 Si tu utilises `discord.ext.tasks`, la méthode `.is_running()` existe
> toujours. C'est la façon officielle d'éviter ce bug.

---

<a name="3"></a>
## 3. 📂 Préparer ton dossier de bot proprement

Ton bot est dans :
`C:\Users\gabri\Downloads\discord-trading-bot\discord-trading-bot\`

Ce dossier doit contenir **au minimum** :

```
discord-trading-bot/
├── bot_btc_court.py        ← ton bot
├── requirements.txt        ← la liste des librairies (on la crée juste après)
├── .env                    ← tes secrets (token, etc.) — JAMAIS partagé
├── Dockerfile              ← dit au cloud comment lancer le bot
└── .gitignore              ← cache les fichiers sensibles
```

### a. Créer `requirements.txt`

Dans le dossier, crée un fichier `requirements.txt`. Mets-y les librairies que ton
bot utilise. D'après ton bot, ce sera probablement :

```
discord.py>=2.3.0
ccxt>=4.2.0
pandas>=2.1.0
numpy>=1.26.0
requests>=2.31.0
python-dotenv>=1.0.0
```

> ❓ Pas sûr de la liste ? Dans ton `cmd`, tape :
> ```bash
> pip freeze > requirements.txt
> ```
> Ça génère automatiquement la liste de TOUTES tes librairies installées.

### b. Créer `Dockerfile` (sans extension)

Crée un fichier nommé exactement `Dockerfile` (pas `Dockerfile.txt` !) avec :

```dockerfile
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

CMD ["python", "bot_btc_court.py"]
```

> ⚠️ Sous Windows, le Bloc-notes ajoute parfois `.txt`. Pour l'éviter : dans
> l'explorateur, active « Extensions de noms de fichiers » et renomme en
> `Dockerfile` tout court.

### c. Créer `.gitignore`

Crée un fichier `.gitignore` avec :

```
.env
*.log
__pycache__/
*.pyc
.venv/
```

Ça empêche d'envoyer ton **token secret** sur internet par accident.

---

<a name="4"></a>
## 4. 🔑 Mettre tes secrets dans un fichier `.env`

**Ne mets JAMAIS ton token Discord directement dans le code.** Crée un fichier
`.env` dans le dossier :

```env
DISCORD_TOKEN=ton_token_discord_ici
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxx/yyyy
```

Puis dans `bot_btc_court.py`, en haut du fichier, assure-toi de lire ces valeurs
depuis l'environnement (au lieu de les écrire en dur) :

```python
import os
from dotenv import load_dotenv

load_dotenv()  # charge le .env en local

TOKEN = os.getenv("DISCORD_TOKEN")
# ... à la fin de ton fichier :
client.run(TOKEN)
```

> Si actuellement tu as `client.run("MTI3...")` avec le token écrit en clair :
> remplace-le par `client.run(TOKEN)` comme ci-dessus.

---

<a name="5"></a>
## 5. 🧪 Tester une dernière fois en local

Avant d'envoyer dans le cloud, vérifie que tout marche encore :

```bash
cd C:\Users\gabri\Downloads\discord-trading-bot\discord-trading-bot
pip install -r requirements.txt
python bot_btc_court.py
```

✅ Si le bot se connecte sans l'erreur `Task is already launched` → parfait, tu
peux déployer. Ferme avec `Ctrl + C`.

---

<a name="6"></a>
## 6. ☁️ Choisir l'hébergeur

| Hébergeur | Difficulté | Gratuit ? | Recommandé pour toi |
|-----------|-----------|-----------|---------------------|
| **Railway** | ⭐ Très facile | Crédit gratuit/mois | ✅ **OUI, commence par ça** |
| **Fly.io** | ⭐⭐ Moyen | Oui (carte requise) | Alternative solide |
| Render | ⭐⭐ Moyen | Oui (worker) | Alternative |

👉 **Je te recommande Railway** : pas de ligne de commande, tout se fait dans le
navigateur. Suis la section 7. (Fly.io est en section 8 si tu préfères.)

---

<a name="7"></a>
## 7. 🚆 DÉPLOIEMENT A — Railway (le plus simple)

### Étape 7.1 — Mettre ton code sur GitHub
Railway déploie depuis GitHub. Si ton code n'y est pas encore :

1. Crée un compte sur https://github.com (gratuit).
2. Installe **GitHub Desktop** (https://desktop.github.com) — interface simple.
3. Dans GitHub Desktop : `File → Add local repository` → choisis ton dossier
   `discord-trading-bot`.
4. Clique **Publish repository**. ⚠️ **Coche « Keep this code private »** (ton
   token ne doit pas être public — même si `.env` est ignoré, reste privé).

> Le fichier `.env` ne sera PAS envoyé grâce à ton `.gitignore`. C'est normal et
> voulu : on remettra les secrets directement dans Railway.

### Étape 7.2 — Créer le projet Railway
1. Va sur https://railway.app → **Login with GitHub**.
2. Clique **New Project** → **Deploy from GitHub repo**.
3. Autorise Railway à voir tes repos → choisis `discord-trading-bot`.
4. Railway détecte ton `Dockerfile` et commence à construire le bot.

### Étape 7.3 — Ajouter tes secrets
1. Dans ton projet Railway → onglet **Variables**.
2. Clique **New Variable** et ajoute :
   - `DISCORD_TOKEN` = ton token
   - `DISCORD_WEBHOOK_URL` = ton URL de webhook
3. Railway redéploie automatiquement.

### Étape 7.4 — Vérifier que c'est un worker (pas un site web)
Ton bot n'a pas de page web. Railway le lance en continu grâce au `Dockerfile`
(la ligne `CMD ["python", "bot_btc_court.py"]`). Rien d'autre à faire.

### Étape 7.5 — Voir les logs
Onglet **Deployments** → clique sur le déploiement actif → **View Logs**. Tu dois
voir « Connecté en tant que … » et tes lignes `[BTC COURT] Analyse`.

✅ **C'est fini !** Ton bot tourne maintenant 24/7. Tu peux éteindre ton PC.

---

<a name="8"></a>
## 8. 🪰 DÉPLOIEMENT B — Fly.io (alternative)

Si tu préfères Fly.io (utilise un peu la ligne de commande) :

### 8.1 — Installer flyctl
Ouvre PowerShell (Windows) et tape :
```powershell
pwsh -Command "iwr https://fly.io/install.sh -useb | iex"
```
Puis crée un compte :
```bash
fly auth signup
```

### 8.2 — Créer un `fly.toml`
Dans ton dossier, crée `fly.toml` :
```toml
app = "mon-bot-btc"          # choisis un nom unique
primary_region = "cdg"       # Paris

[build]

[processes]
  app = "python bot_btc_court.py"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
  processes = ["app"]
```

### 8.3 — Lancer et déployer
Depuis le dossier du bot :
```bash
fly launch --no-deploy        # garde le fly.toml existant (réponds "non" si on propose de l'écraser)

fly secrets set DISCORD_TOKEN="ton_token"
fly secrets set DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/xxxx/yyyy"

fly deploy
fly scale count 1             # garde 1 machine toujours allumée
```

### 8.4 — Voir les logs
```bash
fly logs
```

---

<a name="9"></a>
## 9. ✅ Vérifier que ça tourne

Quelle que soit la méthode :
- **Railway** : onglet *Deployments → View Logs*
- **Fly.io** : commande `fly logs`

Tu dois voir tes lignes habituelles :
```
Connecté en tant que MonBot#1234
[BTC COURT] Analyse — 15:18:13
[BTC COURT] WAIT
```

🎉 Si oui, **ton bot tourne dans le cloud, sans ton PC.**

---

<a name="10"></a>
## 10. 🆘 Questions fréquentes / dépannage

**« Le bot plante avec `Task is already launched » »**
→ Tu n'as pas appliqué la correction de la [section 2](#2). Ajoute le
`if not analyze_loop.is_running():`.

**« Le déploiement échoue sur `pip install` »**
→ Une librairie manque ou est mal écrite dans `requirements.txt`. Regarde les
logs de build, corrige le nom, redéploie.

**« Mon token est-il en sécurité ? »**
→ Oui, tant qu'il est dans les **Variables** (Railway) ou **secrets** (Fly) et
**jamais** dans le code ni dans un repo public. Si tu l'as déjà mis en clair sur
GitHub : régénère un nouveau token dans le portail Discord Developer et remplace-le.

**« Ça coûte combien ? »**
→ Railway offre un crédit gratuit mensuel, largement suffisant pour un petit bot.
Fly.io a un quota gratuit (carte bancaire demandée pour vérification, mais pas
débitée tant que tu restes dans le quota).

**« Comment je mets à jour mon bot ? »**
→ *Railway* : tu modifies ton code, tu le `push` sur GitHub (via GitHub Desktop :
Commit + Push), Railway redéploie tout seul. *Fly* : tu refais `fly deploy`.

**« Le bot s'arrête après quelques heures »**
→ Sur Railway, vérifie que tu n'as pas dépassé ton crédit gratuit. Sur Fly,
vérifie `fly scale count 1` pour garder une machine allumée.

---

## 📝 RÉCAPITULATIF EXPRESS

1. ✅ Corriger `on_ready` (section 2) — **obligatoire**
2. ✅ Créer `requirements.txt`, `Dockerfile`, `.gitignore`, `.env`
3. ✅ Lire le token via `os.getenv("DISCORD_TOKEN")`
4. ✅ Tester en local
5. ✅ Pousser sur GitHub (privé)
6. ✅ Railway → New Project → Deploy from GitHub
7. ✅ Ajouter les Variables (token + webhook)
8. ✅ Vérifier les logs → bot 24/7 🎉

**Ordre recommandé : Railway** (tout dans le navigateur, le plus simple pour toi).
