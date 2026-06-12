# ⚙️ Configuration Vapi — réglages exacts (Phase 1)

Guide pas à pas pour configurer ton premier agent qui parle. Tu n'as qu'à suivre
et recopier. **Aucune ligne de code.**

> Les noms exacts des menus peuvent légèrement varier (Vapi évolue). Si tu ne
> trouves pas un réglage, dis-le-moi et je t'aide à le repérer.

---

## Étape par étape dans le tableau de bord Vapi

### 1. Créer l'assistant
- Menu **Assistants** → **Create Assistant** → nomme-le `L'Atelier Coiffure`.

### 2. Le cerveau (Model)
- **Provider :** Anthropic
- **Model :** `claude-haiku-4-5` (rapide → idéal pour le téléphone, faible latence)
- **Temperature :** `0.5` (naturel mais maîtrisé)
- **System Prompt :** colle le bloc fourni dans `system-prompt.md`
- **First Message :** `L'Atelier Coiffure, bonjour ! Je suis l'assistant du salon. Comment puis-je vous aider ?`

### 3. La voix (Voice / TTS) — le plus important pour le côté premium
Choisis UNE des deux options :
- **Option A — Cartesia** (recommandée pour la latence)
  - Provider : Cartesia · Model : Sonic · Language : **French (fr)**
  - Choisis une voix française féminine chaleureuse → on testera 2-3 voix.
- **Option B — ElevenLabs** (voix très expressives)
  - Provider : ElevenLabs · Model : `eleven_multilingual_v2`
  - Voix française → réglages : Stability ~0.5, Similarity ~0.75.

> On comparera les deux à l'oreille en Phase 1 et on garde la meilleure.

### 4. La reconnaissance vocale (Transcriber / STT)
- **Provider :** Deepgram · **Model :** `nova-2` · **Language :** `fr`
- (Deepgram nova-2 gère bien le français et reste très réactif.)

### 5. Les réglages de conversation (pour un rythme humain)
- **Interruptions (barge-in) :** activé → on peut couper l'agent comme un humain.
- **Silence timeout :** ~10 s avant relance.
- **End call phrases :** `au revoir`, `bonne journée`, `merci au revoir`.
- **Max call duration :** 10 min (sécurité pour les tests).

### 6. Le numéro de téléphone
- Menu **Phone Numbers** → **Buy Number** (ou importer un numéro Twilio).
- Attache ce numéro à l'assistant `L'Atelier Coiffure`.
- Coût indicatif : ~1-2 $/mois, souvent couvert par les crédits d'essai.

### 7. Appeler !
- Compose le numéro depuis ton portable et déroule la
  [`checklist-test.md`](checklist-test.md).

---

## 💶 Coûts en phase de test (ordre de grandeur)
| Poste | Coût indicatif |
|-------|----------------|
| Numéro de téléphone | ~1-2 $/mois |
| Appel (tout compris : STT + LLM + TTS + tél.) | ~0,10-0,20 € / minute |
| Crédits d'essai Vapi | ~10 $ offerts (suffisant pour la Phase 1) |

➡️ **Conclusion : la Phase 1 tient largement dans les crédits gratuits.**

## 🔐 Sécurité des accès
- Tu crées les comptes **toi-même** ; tu restes propriétaire.
- Quand on branchera l'agenda (Phase 2), on utilisera des **clés API** (jamais
  ton mot de passe). Je t'expliquerai où les coller, en sécurité.
- On ne mettra **aucune clé secrète** dans ce dépôt Git.
