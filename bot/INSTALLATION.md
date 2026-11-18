# Installer et lancer le détecteur sur ton ordinateur (guide pas à pas)

Le détecteur doit tourner sur une machine qui peut joindre l'API publique de Binance Futures. C'est le cas depuis
la France ; ce n'est **pas** le cas des serveurs situés aux États-Unis (dont GitHub Actions), qui reçoivent une
erreur 451. Ne contourne pas cette restriction (VPN, proxy) : les conditions de Binance l'interdisent.

Le détecteur ne passe **aucun ordre** et n'utilise **aucune clé API** : il lit seulement des données publiques.
En mode observation (le mode actuel), il n'envoie rien sur Discord : il enregistre et suit les signaux en privé.

## 1. Ce qu'il te faut

- Un ordinateur Windows, Mac ou Linux, allumé aux heures où tu veux suivre le marché (un oubli n'est pas grave :
  au redémarrage, le détecteur rattrape les bougies manquées).
- Environ 2 Go d'espace disque libre.
- Une connexion Internet.

## 2. Installer Python et Git

- **Windows** : télécharge Python 3.12 sur https://www.python.org/downloads/ et, pendant l'installation, coche
  **« Add python.exe to PATH »**. Télécharge Git sur https://git-scm.com/download/win (options par défaut).
- **Mac** : installe Python 3.12 depuis https://www.python.org/downloads/ ; Git s'installe tout seul la première
  fois que tu tapes `git` dans le Terminal.
- **Linux** : `sudo apt install python3 python3-venv git` (Debian/Ubuntu).

Vérifie dans un terminal (Windows : « Invite de commandes » ou « PowerShell » ; Mac : « Terminal ») :

```bash
python --version
```

La version doit être 3.11 ou plus récente (sur Mac et Linux, la commande s'appelle parfois `python3`).

## 3. Récupérer le code

```bash
git clone https://github.com/gabrielsebban3-code/bot-de-trading-btc-alt.git
```

```bash
cd bot-de-trading-btc-alt
```

```bash
git checkout claude/sweet-ramanujan-kNRqe
```

(Une fois la branche fusionnée dans la branche principale, cette dernière commande ne sera plus nécessaire.)

## 4. Créer l'environnement Python et installer les dépendances

```bash
python -m venv .venv
```

Active-le (à refaire à chaque nouveau terminal) :

- Windows :

```bash
.venv\Scripts\activate
```

- Mac / Linux :

```bash
source .venv/bin/activate
```

Puis installe les bibliothèques :

```bash
pip install -r bot/requirements.txt
```

## 5. Configuration

- Tous les réglages sont dans `bot/config.yaml`. **Ne les modifie pas** : ils sont figés par le protocole.
  Le seul réglage prévu pour toi est `live.mode`, qui doit rester `observation` tant qu'aucun concept n'est validé.
- Secret Discord (facultatif, inutile en mode observation) : copie `bot/.env.example` en `bot/.env` et colle
  l'URL du webhook après `DISCORD_WEBHOOK_URL=`. Ce fichier n'est jamais envoyé sur GitHub (il est ignoré par git).
  Pour créer le webhook : dans Discord, **Modifier le salon → Intégrations → Webhooks → Nouveau webhook → Copier
  l'URL du webhook**.

## 6. Premier lancement (une seule passe, rien n'est envoyé)

```bash
python -m bot.main scan --dry-run
```

La première fois, le détecteur télécharge environ 14 mois d'historique en bougies de 15 minutes pour les paires du
top 30 (5 à 15 minutes). Il affiche ensuite un résumé : nombre de paires, signaux nouveaux, événements.
Relance la même commande : le résumé doit montrer **0 nouveau signal** (aucun doublon).

## 7. Lancement en continu

```bash
python -m bot.main live
```

Le détecteur écoute la clôture de chaque bougie de 15 minutes (websocket Binance) et lance un passage à chaque
clôture. Il se reconnecte tout seul et rattrape les trous. Laisse le terminal ouvert ; `Ctrl + C` pour arrêter.

### Démarrage automatique (facultatif)

- **Windows** : ouvre le « Planificateur de tâches » → « Créer une tâche » → Déclencheur : « À l'ouverture de
  session » → Action : « Démarrer un programme » avec
  - Programme : `C:\chemin\vers\bot-de-trading-btc-alt\.venv\Scripts\python.exe`
  - Arguments : `-m bot.main live`
  - Commencer dans : `C:\chemin\vers\bot-de-trading-btc-alt`
- **Mac** : crée `~/Library/LaunchAgents/fr.dinexo.bot.plist` avec `ProgramArguments` =
  `[chemin/.venv/bin/python, -m, bot.main, live]`, `WorkingDirectory` = le dossier du dépôt, `RunAtLoad` = true,
  puis `launchctl load ~/Library/LaunchAgents/fr.dinexo.bot.plist`.
- **Linux** : un service utilisateur systemd avec `ExecStart=chemin/.venv/bin/python -m bot.main live` et
  `WorkingDirectory=` le dossier du dépôt.

## 8. Vérifier que ça tourne

- Journal : `bot/var/bot.log` (une ligne JSON par événement : « scan done », erreurs éventuelles).
- Signaux et statuts : base `bot/var/state.sqlite` (lisible avec « DB Browser for SQLite », gratuit).
- Test final : la commande suivante écrit `bot/reports/FORWARD.md`. Les performances restent **masquées** tant
  qu'une variante n'a pas 100 trades clos et 3 mois d'observation : c'est voulu, pour ne pas fausser le test.

```bash
python -m bot.main forward-report
```

## 9. Mettre à jour

```bash
git pull
```

```bash
pip install -r bot/requirements.txt
```

Les bases `bot/var/*.sqlite` sont conservées : la mise à jour ne perd ni les signaux ni l'historique.

## 10. Dépannage

| Message | Cause | Que faire |
|---|---|---|
| `HTTP 451` / `restricted location` | Binance refuse ta localisation | Lancer depuis un autre endroit autorisé ; ne pas contourner |
| `ModuleNotFoundError: No module named 'bot'` | Lancé depuis le mauvais dossier | `cd` dans le dossier du dépôt avant la commande |
| `python` introuvable | Python pas dans le PATH | Réinstaller en cochant « Add python.exe to PATH » |
| Le résumé indique `symbols_with_data: 0` | Historique pas encore téléchargé | Relancer `scan --dry-run` et attendre la fin |

## Ce que le détecteur ne fait pas (honnêtement)

- Il ne prédit pas les sommets ni les creux. Il détecte des configurations dont l'espérance a été mesurée.
- Aujourd'hui, **aucun concept n'a d'edge prouvé**. En observation, il construit les données qui permettront de le
  savoir (test final : au moins 100 trades et 3 mois).
- Il ne passe aucun ordre. Ce n'est pas un conseil financier.
