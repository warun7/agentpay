# ADR-014: Unified Webhook-Driven Settlement Confirmation

**Status:** Accepted
**Date:** 2026-08-25
**Phase:** 3 — Razorpay Webhook Pipeline

## Context

AgentPay has two gateway modes: mock/UAP-simulated (default) and Razorpay test-mode Orders API. Previously, settlement confirmation happened inline inside `processAgenticCheckout` — the receipt was declared `CAPTURED` the moment the simulated capture returned. Nothing existed to receive real Razorpay webhook deliveries, and no component distinguished "gateway said captured" from "we decided it was captured."

For judges and for production honesty, capture **confirmation** must be a distinct, verifiable event — and it must work identically in both modes.

## Decision

1. **One confirmation path.** A process-wide `PaymentEventBus` (`src/payment/webhook-events.ts`) carries `payment.captured` / `payment.failed` events with a `source` discriminator:
   - `internal-synthetic`: emitted by `MerchantAgent.handleSignedTransaction` immediately after persisting the settled record (mock/UAP-simulated captures).
   - `razorpay-webhook`: published by `POST /api/webhooks/razorpay` after HMAC verification of an externally delivered Razorpay webhook.
   Downstream consumers (idempotent confirmer, dashboard WS feed) cannot tell the modes apart.

2. **Signature verification over raw bytes.** Fastify's JSON parser is replaced with a string-parsing variant that stashes the exact request bytes on `request.rawBody`. `verifyWebhookSignature` computes HMAC-SHA256 over those raw bytes and compares against `X-Razorpay-Signature` in constant time. Re-serialized JSON would break the HMAC; raw capture is mandatory.

3. **Idempotency at two layers.**
   - Route level: `PROCESSED_WEBHOOKS` set keyed by `event:orderId:paymentId` → duplicate deliveries ack with `duplicate: true`.
   - Domain level: `MerchantAgent.confirmCapture()` stamps `confirmedAt/confirmedBy` once; repeat confirmations are explicit no-ops.

4. **Publish-after-persist.** The synthetic event is emitted by the merchant *after* the record is stored (indexed by nonce, transactionId, AND razorpayOrderId). The first implementation published from inside the gateway before persistence — a race the integration test caught (`confirmCapture` missed every lookup). Ownership rule: the component that owns the state emits its own lifecycle events.

5. **Ack semantics.** Validly-signed webhooks referencing unknown orders still return 200 (logged as unmatched). Erroring would trigger Razorpay retry storms for events we simply don't own.

6. **Boot-time config validation.** `RazorpayGateway` warns loudly when `MOCK_MODE=false` but credentials look placeholder (auto-falls back to simulation), or when real keys sit unused behind mock mode.

## Consequences

- Live activation is config-only: set `RAZORPAY_MOCK_MODE=false`, paste `rzp_test_*` keys, register the webhook URL + secret (see `.env.example`). No code changes.
- The demo story is defensible under questioning: *"Orders are real test-mode API calls; autonomous UPI capture remains NPCI-UAP simulated until mandate rails exist, and confirmation always flows through the same audited pipeline a live webhook would."*
- `SETTLEMENT_CONFIRMED` / `SETTLEMENT_FAILED` events now stream to `/ws/feed` — groundwork for the Phase 4 live dashboard.

## Verification

- `tests/webhook.test.ts`: 9 tests — HMAC roundtrip/tamper/missing-header, HTTP 401s, duplicate acks, unknown-order acks, and full checkout→synthetic-confirm→external-webhook-idempotency flow.
