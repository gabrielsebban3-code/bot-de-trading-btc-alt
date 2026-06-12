# ⚙️ Configuration Vapi — réglages exacts (Phase 1)

Guide pas à pas pour mettre l'agent en ligne. Tout est en **copier-coller**,
aucune ligne de code. Compte ~30 minutes.

> Les intitulés de menus peuvent varier légèrement (Vapi évolue vite). Si un
> réglage est introuvable, note son nom et dis-le-moi — je t'aide à le repérer.

---

## 1. Créer l'assistant
- Menu **Assistants** → **Create Assistant** → choisis un modèle vierge (« Blank »).
- Nom : `Camille - L'Atelier Coiffure`.

## 2. Le cerveau (section « Model »)
| Réglage | Valeur | Pourquoi |
|---|---|---|
| Provider | **Anthropic** | Les modèles Claude — excellents en français et en suivi de consignes |
| Model | **`claude-haiku-4-5`** (Claude Haiku 4.5) | Le plus rapide de la gamme → indispensable pour une conversation téléphonique fluide |
| Temperature | **0.4** | Naturel mais discipliné (pas d'improvisation sur les tarifs) |
| Max tokens | **250** | Force des réponses courtes — on PARLE, on ne rédige pas |
| System Prompt | **Colle le bloc complet** de [`system-prompt.md`](system-prompt.md) | Le cerveau |
| First Message | `L'Atelier Coiffure, bonjour ! Je suis Camille, l'assistante du salon. Comment puis-je vous aider ?` | L'accueil |

> 🔁 **Option qualité (à tester en Phase 3)** : `claude-sonnet-4-6` (Claude
> Sonnet 4.6) — compréhension encore plus fine, légèrement plus lent et plus
> cher. On compare les deux quand l'agent gérera les cas complexes.

## 3. La voix (section « Voice ») — le critère premium n°1
On teste les **deux** options à l'oreille et on garde la meilleure :

**Option A — Cartesia (recommandée pour la latence)**
- Provider : **Cartesia** · Model : **Sonic** · Language : **French (fr)**
- Choisis une voix française féminine chaleureuse (on en essaiera 2-3).

**Option B — ElevenLabs (voix très expressives)**
- Provider : **ElevenLabs** · Model : **`eleven_multilingual_v2`**
  *(ou la variante « Flash » si proposée — plus rapide)*
- Voix française · Stability ≈ **0.5** · Similarity ≈ **0.75**.

> 🎧 **Astuce premium :** si Vapi propose un **« Background Sound »**, mets
> l'ambiance « office » à volume très faible — un léger fond sonore de salon
> rend l'illusion humaine encore plus forte. À tester, pas obligatoire.

## 4. L'oreille (section « Transcriber »)
| Réglage | Valeur |
|---|---|
| Provider | **Deepgram** |
| Model | **`nova-2`** |
| Language | **`fr`** |

## 5. Le rythme de conversation (sections « Advanced » / réglages d'appel)
| Réglage | Valeur | Effet |
|---|---|---|
| Interruptions (barge-in) | **Activé** | On peut couper Camille comme un humain — elle s'arrête et écoute |
| Endpointing / « Wait seconds » | Réglage « smart » ou ~0.4 s | Elle ne coupe pas la parole, mais ne laisse pas de blanc |
| Silence timeout | ~10 s | Relance polie si l'appelant ne dit plus rien |
| End call phrases | `au revoir`, `bonne journée`, `merci au revoir` | Raccroche naturellement |
| Max call duration | **10 min** | Garde-fou pour les tests |
| **Recording / enregistrement** | **DÉSACTIVÉ** | RGPD : pas d'enregistrement tant que la conformité n'est pas en place (Phase 4) |

## 6. Le numéro de téléphone
- Menu **Phone Numbers** → **Buy Number** (ou import Twilio plus tard).
- Prends un numéro (les numéros US offerts par l'essai suffisent pour tester ;
  un numéro français viendra avec le premier vrai déploiement).
- **Attache le numéro à l'assistant** `Camille - L'Atelier Coiffure`.

> 📞 Pas envie d'acheter un numéro tout de suite ? Le bouton **« Talk to
> assistant »** du dashboard permet de parler à Camille directement depuis le
> navigateur — parfait pour les tout premiers essais.

## 7. Appeler 🎉
Compose le numéro (ou utilise « Talk to assistant ») et déroule le
[protocole de test](checklist-test.md).

---

## 💶 Coûts en phase de test (ordres de grandeur)
| Poste | Coût |
|---|---|
| Crédits d'essai Vapi | ~10 $ offerts → couvre toute la Phase 1 |
| Appel tout compris (STT + IA + voix + téléphonie) | ~0,10–0,20 € / minute |
| Numéro de téléphone | ~1–2 $/mois |

## 🔐 Sécurité
- Tu restes propriétaire du compte Vapi ; ne partage jamais ton mot de passe.
- Aucune clé secrète ne sera jamais enregistrée dans ce dépôt Git.
- En Phase 2 (agenda), on utilisera des clés API à coller **dans Vapi uniquement** — je te guiderai.
