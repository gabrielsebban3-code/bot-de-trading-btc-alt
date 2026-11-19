# gta6-clipper

Outil **local et privé** : il cherche des vidéos YouTube en français sur GTA 6, repère les meilleurs moments, les découpe en clips verticaux 1080x1920 (fond flou, sous-titres, crédit de la chaîne) et les affiche dans un site qui tourne sur ta machine.

- Usage personnel et non lucratif. Rien n'est publié ni envoyé à un service tiers.
- Chaque clip garde le crédit `Source : <chaîne>` incrusté et le lien vers la vidéo originale au bon moment.
- ⚠️ **N'expose jamais ce site sur Internet** (pas de redirection de port, pas de tunnel). Il est fait pour `127.0.0.1` ou, au mieux, pour ton Wi-Fi domestique avec mot de passe.
- Honnêtement : les conditions d'utilisation de YouTube interdisent en principe de télécharger des vidéos sans l'autorisation de la plateforme. L'outil ne contourne aucune protection (pas de DRM, pas de compte, pas de proxy), mais c'est à toi d'assumer cet usage.

## Installation

1. Python 3.11 ou plus récent, et **ffmpeg** :
   - Debian/Ubuntu : `sudo apt install ffmpeg`
   - macOS : `brew install ffmpeg`
   - Windows : `winget install ffmpeg`
2. Dans le dossier `gta6-clipper/` :

```bash
python3 -m venv .venv
```

```bash
source .venv/bin/activate
```

```bash
pip install -e .
```

```bash
cp .env.example .env
```

Au premier lancement, faster-whisper télécharge le modèle `small` (environ 500 Mo) depuis HuggingFace. C'est le seul téléchargement hors YouTube, et il n'a lieu qu'une fois.

### Clé YouTube (facultative)

Sans clé, la recherche passe par yt-dlp (recherche YouTube filtrée par date de mise en ligne). Avec une clé YouTube Data API v3 (gratuite, sur Google Cloud Console, API « YouTube Data API v3 »), mets `YOUTUBE_API_KEY=...` dans `.env`. Une exécution consomme environ 600 unités sur les 10 000 du quota quotidien. Si le quota est dépassé, l'outil bascule tout seul sur yt-dlp.

## Commandes

```bash
gta6-clipper run
```

```bash
gta6-clipper run --dry-run
```

```bash
gta6-clipper run --url "https://www.youtube.com/watch?v=XXXXXXXXXXX"
```

```bash
gta6-clipper run --keep-temp
```

```bash
gta6-clipper serve
```

```bash
gta6-clipper serve --lan --port 8000
```

```bash
gta6-clipper status
```

```bash
gta6-clipper doctor
```

- `run` : recherche, découpe et ajout des clips au site.
- `--dry-run` : affiche les clips prévus avec leurs timestamps et le détail des signaux. Il télécharge uniquement la piste audio, nécessaire à l'analyse, et aucune vidéo. La transcription est mise en cache, donc le vrai `run` suivant ne la refait pas.
- `--url` : traite une seule vidéo, sans les filtres de recherche.
- `serve` : ouvre le site sur http://127.0.0.1:8000.
- `run --url <lien> --at 41:20` : un seul clip autour de ce minutage. Un lien YouTube « partager à partir de » (`?t=2480`) marche aussi, comme le champ « à 41:20 ? » du site.
- `doctor` : vérifie l'installation (Python, ffmpeg, bibliothèques, recherche YouTube, modèle, port 8000). À lancer en premier si quelque chose ne marche pas.

## Mise à jour (Windows)

Arrête le site, puis double-clique sur `maj.bat` dans le dossier `gta6-clipper`. Il télécharge la dernière version, remplace `src`, `pyproject.toml`, `requirements.txt` et `README.md`, puis met à jour les dépendances. Il met aussi yt-dlp à jour (YouTube change souvent, et une vieille version finit par casser les téléchargements), puis se met lui-même à jour. Il ne touche pas à `.venv`, `data` (tes clips), `config.yaml` ni `.env`.

## Accès depuis le téléphone (même Wi-Fi)

1. Mets `SITE_PASSWORD=un-mot-de-passe-solide` dans `.env`. Sans mot de passe, `serve --lan` refuse de démarrer.
2. Lance `gta6-clipper serve --lan`.
3. Trouve l'IP locale de ton PC (`ip addr`, `ipconfig`, ou Réglages réseau, par exemple `192.168.1.20`) et ouvre `http://192.168.1.20:8000` sur le téléphone.

La session est un cookie signé (HttpOnly, 30 jours). En mode local (`127.0.0.1`), il n'y a pas de login.

## Le site

- Grille de clips 9:16. Les non vus sont encadrés et marqués « NOUVEAU ».
- Lecteur vertical en plein écran, streaming par plages (Range).
- Raccourcis : **↑** suivant, **↓** précédent, **F** favori, **Suppr** supprimer, **Échap** fermer. Sur téléphone, balaye vers le haut pour passer au clip suivant.
- Boutons Télécharger, Favori, Supprimer (fichier et ligne SQLite) et « Voir la vidéo originale à ce moment ».
- Filtres : tous / non vus / favoris, par vidéo, par chaîne. Tri par date ou par score.
- « Lancer une recherche maintenant » démarre le pipeline en tâche de fond, avec une progression par étape (rafraîchie toutes les 1,5 s). Un seul job à la fois.
- La page Réglages modifie les requêtes, le nombre de vidéos et de clips, les listes de chaînes, les sous-titres et le nettoyage.
- Aucun CDN, aucune police externe, aucun tracker. Une CSP `default-src 'self'` le garantit.

## Publier sur TikTok (manuellement)

Dans le lecteur, le bouton **« 📤 Publier sur TikTok »** prépare tout. Il propose une légende modifiable (titre, crédit avec le lien vers la vidéo originale au bon moment, hashtags réglables dans Réglages), un bouton pour la copier, le téléchargement de la vidéo et l'ouverture de tiktok.com/upload. **Le site n'envoie rien à TikTok** : c'est toi qui publies. « Marquer comme publié » ajoute un badge et permet de filtrer « Pas encore publiés / Publiés ».

⚠️ Publier les clips d'autres créateurs, même crédités, n'équivaut pas à leur accord : TikTok peut retirer les vidéos ou sanctionner le compte. Une publication directe par l'API officielle de TikTok demanderait une application développeur, et elle est limitée à la visibilité privée tant que TikTok n'a pas audité l'application.

## Planification

**Windows** : double-clique sur `planifier.bat`, puis choisis l'heure (18:00 par défaut). Un traitement est programmé chaque jour dans le Planificateur de tâches, via `lancer_run.bat`, avec un journal dans `data\run.log`. Il tourne si le PC est allumé et ta session ouverte. Pour l'arrêter : `schtasks /Delete /TN gta6-clipper /F`.

**Linux/macOS** :

Cron, une exécution par jour à 7 h :

```
0 7 * * * cd /chemin/vers/gta6-clipper && .venv/bin/gta6-clipper run >> data/cron.log 2>&1
```

Service systemd facultatif pour `serve`, à placer dans `~/.config/systemd/user/gta6-clipper.service` :

```ini
[Unit]
Description=gta6-clipper (site local)

[Service]
WorkingDirectory=/chemin/vers/gta6-clipper
ExecStart=/chemin/vers/gta6-clipper/.venv/bin/gta6-clipper serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now gta6-clipper
```

## Fonctionnement

1. **Recherche** (`search.py`) : API v3 (`relevanceLanguage=fr`, `order=viewCount`, `publishedAfter`) ou yt-dlp. Les filtres portent sur la durée, l'âge, les vues, les lives, la langue et les listes de chaînes. Les vidéos déjà en base sont ignorées.
2. **Audio seul** (`download.py`), en basse qualité, converti en WAV 16 kHz mono.
3. **Transcription** (`transcribe.py`) : faster-whisper, langue `fr`, VAD, mise en cache SQLite. Une détection de langue sur 30 s écarte les vidéos qui ne sont pas en français.
4. **Moments** (`scoring.py`) : heatmap « most replayed », RMS audio par seconde et densité de mots-clés plus changements de sujet. Chaque signal est normalisé entre 0 et 1, puis pondéré. On calcule ensuite des fenêtres glissantes et on garde les K meilleurs pics, espacés d'au moins 60 s. Chaque clip est aligné sur les segments Whisper (60 à 90 s par défaut, marge de 0,5 s).
5. **Segments vidéo seuls** (`download_ranges`) : seuls les passages retenus sont téléchargés, pas la vidéo entière.
6. **Rendu** (`vertical.py`) : fond flou, vidéo centrée, sous-titres ASS dans le tiers bas, crédit, loudnorm, H.264 CRF 21 + AAC, 30 fps, `faststart`. Une miniature JPG est prise au milieu du clip.
7. **Nettoyage** : les clips non favoris de plus de 30 jours sont supprimés, et l'espace total est plafonné à 10 Go. Les favoris ne sont jamais supprimés automatiquement.

Les fichiers vont dans `data/clips/<id>.mp4`, `data/thumbs/<id>.jpg` et `data/db.sqlite`. Ce dossier est créé automatiquement et ignoré par git.

## Choix techniques simplificateurs

- **Score de recherche** : `0,7 × vues/heure + 0,3 × ratio likes/vues`, chaque terme normalisé entre 0 et 1 sur les candidats. Additionnés bruts, le ratio (environ 0,03) serait négligeable face aux vues par heure.
- **Liste blanche** : elle donne la priorité (bonus de +1, et le minimum de vues ne s'applique pas). Elle ne restreint pas la recherche à ces chaînes.
- **Sans clé API**, la date, les likes et la heatmap demandent une extraction détaillée par vidéo. Elle est plafonnée à `max_candidates` (20) et mise en cache 24 h.
- **Coupe précise** : `force_keyframes_at_cuts` oblige yt-dlp à réencoder le segment. C'est plus lent, mais sans ça, la vidéo démarre figée ou désynchronisée.
- **Heatmap absente** ou **transcription vide** : les poids des signaux manquants sont redistribués sur ceux qui restent. Sans transcription, la coupe n'est pas alignée sur des phrases.
- Une vidéo en échec (statut `error`) est retentée par la recherche automatique jusqu'à `max_attempts` fois (3 par défaut). `run --url` la force à tout moment.
- **Notation des moments** :
  - la heatmap compte par rapport à son niveau habituel (seuls les vrais pics ressortent) ;
  - le son compte quand il monte d'un coup par rapport aux 2 minutes autour (cri, fou rire), pas à son niveau absolu, ce qui neutralise un jeu bruyant en permanence ;
  - les mots-clés incluent des réactions orales (« mdr », « oh non », « c'est fou »…) ;
  - les instants cités dans les commentaires (« 23:45 ») sont lus localement par yt-dlp, sur les 100 commentaires les plus populaires ;
  - le pic est placé dans la seconde partie du clip, pour garder la mise en place avant ;
  - l'intro (60 s) et l'outro (45 s) sont exclues.

  Le lecteur du site affiche pour chaque clip la raison de son choix.
- **Mise en page** (inspirée de vrais clips de pages TikTok GTA 6) :
  - cadrage `zoom` (carré, bandes noires, le défaut), `noir` (16:9 sur fond noir) ou `flou` ;
  - titre accrocheur en haut, en encadré blanc ou en texte avec ombre. En mode `auto`, c'est la phrase la plus frappante du passage, précédée du nom de la chaîne ; à défaut, le titre de la vidéo. Les emojis sont retirés, car la police ne les dessine pas.
  - le titre se modifie dans le lecteur du site : le clip est refait en retéléchargeant seulement son segment, ce qui demande la transcription du passage gardée en base (clips créés après cette version) ;
  - durée : **1 minute minimum par défaut (60-90 s)**, ou moyenne (35-60 s) ou courte (20-45 s) dans la page Réglages. Un `config.yaml` existant passe automatiquement à 60-90 s une fois (`version: 2`).
- **Notes 👍 / 👎** (boutons du lecteur, touches B et N) : dès 3 bons et 3 nuls, chaque traitement ajuste le poids de chaque signal. Un signal plus fort dans les bons clips que dans les nuls pèse plus, et inversement, avec un facteur entre 0,3 et 2. Les poids utilisés sont affichés dans Réglages et dans le journal. On le désactive avec `moments.learn_from_ratings: false`.
- **Chat des lives YouTube** : pour la rediffusion d'un live, le chat est récupéré localement par yt-dlp et réduit à des comptes par seconde (gardés en cache). Le signal mesure la vitesse du chat par rapport à son rythme habituel (médiane sur 5 min), plus les réactions (« mdr », « ptdr », 😂, « clip »…), avancé de 6 s parce que les spectateurs réagissent après le moment. Poids `chat: 0.6`. C'est la méthode de heistclips, sans service tiers.
- **Montage dynamique** (`render.jump_cuts`, activé par défaut, réglable dans Réglages) : les silences de 0,7 s ou plus entre deux mots et les « euh / heu / hum / bah » sont coupés, avec une marge de 0,25 s autour de la parole. Image, son et sous-titres restent synchronisés (`select` / `aselect` de ffmpeg). Les coupes les plus longues passent en premier, et elles ne font jamais descendre le clip sous la durée minimum (1 min).
- **Musique d'ambiance** (`render.music`, activée par défaut) : un morceau du dossier `data/music` (.mp3, .m4a, .wav…) est choisi pour chaque clip, toujours le même pour un clip donné. Il passe sous la voix avec un ducking (`sidechaincompress`) : la musique baisse dès que quelqu'un parle. Fondu d'entrée et de sortie, volume réglable. **Mets uniquement des morceaux libres de droits** (Bibliothèque audio YouTube, Pixabay Music…, en vérifiant la licence de chacun). Pour TikTok, une musique ajoutée dans l'appli est sous licence et peut profiter des sons tendance.
- **Importer des musiques** : dans Réglages, colle le lien d'une playlist YouTube de musiques libres de droits (25 morceaux maximum, en MP3, dans `data/music`), ou lance `gta6-clipper music <lien de playlist>`.
- **Pensé pour l'algorithme TikTok** (skill tiktok-growth) : TikTok classe d'abord sur le taux de visionnage complet (environ 70 % visés) et les revisionnages, puis sur les partages ; la 1re seconde décide.
  - **Accroche** (`render.cold_open`) : les 2,5 s les plus fortes du clip (pic de son par rapport aux 30 s autour) sont montrées en ouverture, puis le clip entier.
  - **Pas de fondu au noir**, ni au début (1re seconde) ni à la fin (enchaînement en boucle).
  - **Mot-clé « GTA 6 »** ajouté au titre à l'écran et en tête de légende s'il manque (TikTok lit le texte à l'écran et la légende pour la recherche).
  - Les durées courtes gardent mieux l'attention jusqu'au bout ; 1 min minimum reste le défaut, à la demande de l'utilisateur.
- **Parole obligatoire** : un détecteur de voix (VAD Silero, inclus dans faster-whisper, quelques secondes) repère où quelqu'un parle. Un passage où l'on parle moins de 50 % du temps est quasi éliminé (`min_speech_ratio`). Une vidéo où l'on parle moins de 15 % du temps est ignorée (`min_video_speech_ratio`).
- **Vitesse** (`transcription.mode`, réglable dans la page Réglages) :
  - `rapide` (défaut) : les candidats sont repérés avec la heatmap et l'audio, puis seuls leurs alentours (±20 s) sont transcrits. Le signal mots-clés ne sert alors plus au choix des moments. Sans heatmap, la transcription est complète.
  - `tres_rapide` : pareil, avec `beam_size=1` (sous-titres un peu moins précis).
  - `complete` : toute la vidéo est transcrite.
- Whisper utilise tous les cœurs du processeur (`cpu_threads: 0`). Le rendu final se fait en preset `veryfast` (environ 1,5 fois plus rapide mesuré que `medium` à CRF égal). Le segment intermédiaire que yt-dlp réencode pour couper juste utilise `ultrafast` CRF 16.
- Les sous-titres utilisent l'horaire exact de chaque mot donné par Whisper (`word_timestamps`), ce qui rend la transcription environ 10 à 20 % plus longue.
- Un seul traitement à la fois, que ce soit depuis le site ou le terminal : `data/job.json` partage l'état, avec un battement toutes les 10 s.
- La page Réglages réécrit `config.yaml`, ce qui efface ses commentaires.
- Le scoring LLM est désactivé par défaut. Si tu l'actives (`moments.llm.enabled: true` et `ANTHROPIC_API_KEY`), seuls les 2 ou 3 passages présélectionnés (600 caractères maximum chacun) partent vers l'API Anthropic. La réponse est un seul chiffre, et le résultat est mis en cache dans SQLite. Note que ça envoie du texte à un service tiers.

## Tests

```bash
pytest -q
```

Ils couvrent la sélection des moments (données factices), les filtres de recherche, la génération des sous-titres et les routes du site : liste, filtres, Range, favori, vu, suppression, login, refus de `--lan` sans mot de passe, réglages.
