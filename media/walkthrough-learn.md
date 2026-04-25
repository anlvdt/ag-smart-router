# AI Learning Engine

Grav uses a Karpathy-inspired training recipe to learn your command preferences.

**How it works:**
- **SGD + Momentum** — Confidence scores update with each approve/reject
- **RLVR** — Exit codes (0 = success) provide verifiable rewards
- **Pattern Generalization** — Related commands are grouped automatically
- **Second Brain Wiki** — Knowledge compiled into a persistent wiki

Commands that reach high confidence are automatically promoted to the whitelist.
