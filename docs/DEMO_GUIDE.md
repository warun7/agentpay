# AgentPay — Self-Demo Guide

How to run the product yourself, what to watch for at every step, and what "working correctly" looks like.

---

## 0. Setup (2 min)

```bash
# .env minimum viable config
LLM_ENABLED=true
GEMINI_API_KEY=<your key>          # optional — deterministic strategies work without
OPENROUTER_API_KEY=<optional>      # automatic failover when Gemini rate-limits

npm run dev                        # → http://localhost:3000
```

Keep a second terminal open with `npm test` output ready, and run `npm run chaos` once before demoing so you can speak to it.

**Warm-up rule:** fire ONE checkout before recording/presenting. First Gemini call of the day can take 10–20s (cold); after that rounds land in ~5–15s.

---

## Flow A — One-Click Autonomous Checkout

Click **"Execute Autonomous Checkout"**.

| Watch | Expected | What it proves |
|---|---|---|
| Header chip | `🧪 UAP SIMULATOR (MOCK)` or `⚡ RAZORPAY TEST MODE LIVE` once real keys are set + `RAZORPAY_MOCK_MODE=false` | Gateway mode is honest, not faked |
| Negotiation feed | Bubbles stream in one-by-one **while the button is still spinning**: `DID_EXCHANGE → SESSION_ESTABLISHED → MANDATE_VERIFIED → CATALOG_RECEIVED → INTENT_SENT → QUOTE_RECEIVED → SIGNED → SETTLED` | Live WebSocket feed, not canned animation |
| FSM panel (top right) | Nodes light up left-to-right in lockstep with the feed; timeline steps fill beneath | Deterministic state machine, no illegal jumps |
| **AI decision cards** (only with LLM on) | `AI decision — intent` (why the buyer picked this item) and `AI decision — pricing` (merchant's discount logic). If the model proposed >15%, the card shows `⚠️ Protocol clamp applied` | Explainable AI + the clamp soundbite |
| Settlement summary card | `order_RZP…`, `pay_RZP…`, amount in ₹, UAP mandate ref | Real receipt artifacts |
| Proof Inspector tabs | **Buyer JWS** (detached Ed25519 signature), **VC** (your signed mandate), **ECDH** (session crypto), **Razorpay** (order notes containing VC/JWS digests). "Copy Raw JSON" gives the whole proof bundle | Third-party verifiability |

**Notice:** the DID exchange bubble appears *before* encryption badges start appearing — that's correct (plaintext handshake, then AES-256-GCM tunnel). Every post-handshake frame carries an `Encrypted` badge.

## Flow B — Conversational Checkout

Type into the chat panel (or click chips):

1. **`GPU hours < ₹4.5k`** → full settle. Watch:
   - Typing dots during the 3 LLM hops (~5–15s total)
   - Transcript cards each carry a **"Why:"** rationale block
   - **Budget bar drains** from ₹4,500 by the settled amount
2. **Follow-up in the same session:** `now also get me the vector database`
   - New purchase, budget decrements further — session identity/mandate reused, fresh ECDH per round
3. **🛡️ Guardrail chip** (`under ₹2000`): buyer *downshifts* to the affordable A100 node and settles inside ₹1,500-ish.
4. **Guaranteed rejection:** type `Buy GPU compute under ₹300` → `REJECTED` card quoting the bounds violation ("exceeds mandate cap"). **Nothing settles; budget untouched.** This is your "bounded & gated" money-shot.
5. **Upsell moment:** after any settle with headroom, watch for `REC_OFFERED → REC_ACCEPTED → SETTLED` (growth agent's cross-sell, e.g., Vector DB after an H100).

## Flow C — Measured Money (analytics)

After 2–3 runs that include upsells:

```bash
curl localhost:3000/api/merchant/analytics
```

```json
{
  "transactions": 2,
  "grossRevenuePaise": 451482,
  "recommendations": { "offered": 1, "accepted": 1, "conversionRate": 1,
                       "incrementalRevenuePaise": 90520, "upliftPct": 25.1 }
}
```

That `upliftPct` is the Track-01 "grow merchant revenue" answer — attributed revenue, not vibes.

## Flow D — Failure Handling (the credibility act)

```bash
# 1. Adversarial fuzzing: 10,000 attacks across 7 classes
npm run chaos            # expect: 100% blocked summary + perf benchmarks table

# 2. Full suite: tamper/replay/idempotency/webhook/growth tests
npm test                 # expect: 14 files passed

# 3. Tampered webhook gets a 401 — live:
BODY='{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_x","order_id":"order_x","amount":100,"status":"captured"}}}}'
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/webhooks/razorpay \
  -X POST -H 'Content-Type: application/json' \
  -H "x-razorpay-signature: $(echo $BODY | openssl dgst -sha256 -hmac wrongsecret | cut -d' ' -f2)" \
  -d "$BODY"             # → 401

# Same command with RAZORPAY_WEBHOOK_SECRET as the hmac key → 200 {"accepted":true,...}
```

Atomicity (network drop after signing) is covered by `tests/atomicity.test.ts` — mention it while `npm test` scrolls.

---

## What "broken" looks like (quick triage)

| Symptom | Meaning / Fix |
|---|---|
| Feed stuck after `RUN_STARTED` | Check server terminal — usually a gateway/API error mid-run; deterministic mode still works |
| No AI cards appear | `LLM_ENABLED=false` or no keys — checkout still settles via deterministic policy (by design) |
| Round takes >30s once | Free-tier latency spike; failover chain silently switched provider — check server log for failover lines |
| Chat REJECTED unexpectedly | Read the card's rationale: mandate cap vs cheapest SKU. Working as intended |
| `REC_OFFERED` doesn't always appear | Only when remaining budget fits a recommendation — budget-dependent by design |

## Common questions → where to look

| Question | Where to look |
|---|---|
| "Can the LLM overspend?" | Show guardrail chip reject OR explain HARD OVERRIDE path (`ai-strategy.test.ts`) |
| "Prove messages are encrypted" | Proof Inspector → ECDH tab; `tests/secure-envelope.test.ts`; ADR-006/013 |
| "What if Razorpay double-fires a webhook?" | Duplicate delivery acks `duplicate:true` once (`webhook.test.ts`) |
| "Where's the audit trail?" | Inspector tabs + `/api/audit/:txnId` + transitionHistory in every run response |
| "Is this actually using Razorpay?" | Chip shows mock vs live; `.env` flip is config-only (ADR-014) |
