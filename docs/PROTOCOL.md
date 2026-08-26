# AgentPay Protocol Specification v1.0

The **AgentPay Autonomous Commerce Protocol** defines the exact message sequence, cryptographic assertions, and state machine transitions required for two sovereign AI agents to execute a trustless checkout without human OAuth friction.

---

## 1. Protocol Architecture & Invariants

1. **Deterministic State Machine:** Negotiation follows an immutable linear state progression.
2. **Zero-Trust Wire Format:** All application messages are encapsulated in authenticated AES-256-GCM frames.
3. **No LLM Gateway Execution:** The LLM only determines commercial strategy; all protocol outputs are validated against strict JSON schemas before signing.

```
State Machine Progression:
[INIT] ──► [DID_EXCHANGED] ──► [SESSION_ESTABLISHED] ──► [MANDATE_VERIFIED] ──► 
[CATALOG_RECEIVED] ──► [INTENT_SENT] ──► [QUOTE_RECEIVED] ──► [SIGNED] ──► [SETTLED]
```

---

## 2. Wire Envelope Format

Every WebSocket frame passed between agents uses the following outer envelope structure:

```json
{
  "version": "1.0",
  "sessionId": "sess_8f9a2b1c-3d4e-4f5a-8b9c-0d1e2f3a4b5c",
  "sequenceId": 1,
  "timestamp": "2026-08-23T22:30:00.000Z",
  "encrypted": true,
  "ciphertext": "a1b2c3d4e5f6...",
  "iv": "1234567890abcdef12345678",
  "authTag": "abcdef1234567890abcdef1234567890"
}
```

When `encrypted: false` (only during initial `DID_EXCHANGE` step), the `payload` object is passed in plaintext.

> **Enforcement Status (v1.1):** Encapsulation is **enforced in code**, not merely specified. Both agent handlers auto-detect `WireEnvelope` frames and route them through the `SecureChannel` (`packMessage`/`unpackMessage`): AES-256-GCM decryption with AAD binding of `sessionId:sequenceId:timestamp`, duplicate/stale sequence rejection, and cross-session ID mismatch rejection. Raw object transport ("loopback mode") remains available for in-process tests and simulations only. The session ID is derived deterministically from both parties' DIDs, so buyer and merchant independently derive identical HKDF session keys. See ADR-006 and `tests/secure-envelope.test.ts`.

---

## 3. Protocol Message Types & Exact Schemas

### Step 1: DID Exchange (`DID_EXCHANGE`)
**State:** `INIT` ➔ `DID_EXCHANGED`  
**Direction:** Bidirectional  

```json
{
  "type": "DID_EXCHANGE",
  "sequenceId": 1,
  "timestamp": "2026-08-23T22:30:00.000Z",
  "payload": {
    "agentRole": "buyer",
    "did": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "didDocument": {
      "@context": ["https://www.w3.org/ns/did/v1"],
      "id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      "verificationMethod": [
        {
          "id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#key-1",
          "type": "Ed25519VerificationKey2020",
          "controller": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
          "publicKeyJwk": {
            "kty": "OKP",
            "crv": "Ed25519",
            "x": "O2A4fCT49DaKFUqbC2OYBR5mt3gycxPUReUMWvj-134"
          }
        }
      ],
      "keyAgreement": [
        {
          "id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK#key-2",
          "type": "X25519KeyAgreementKey2020",
          "controller": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
          "publicKeyJwk": {
            "kty": "OKP",
            "crv": "X25519",
            "x": "3p7bfXt9WBCHGU5HG_W8gI6h65eeguP4QW50_30fMQw"
          }
        }
      ]
    }
  }
}
```

---

### Step 2: Mandate Presentation (`MANDATE_PRESENTATION`)
**State:** `SESSION_ESTABLISHED` ➔ `MANDATE_VERIFIED`  
**Direction:** Buyer ➔ Merchant (Encrypted)  

```json
{
  "type": "MANDATE_PRESENTATION",
  "payload": {
    "verifiableCredential": {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      "id": "urn:uuid:vc_9a8b7c6d-5e4f-3a2b-1c0d-e9f8a7b6c5d4",
      "type": ["VerifiableCredential", "AgentSpendingMandate"],
      "issuer": "did:key:z6MkuUserRootWalletKey...",
      "issuanceDate": "2026-08-23T22:00:00.000Z",
      "expirationDate": "2026-09-01T23:59:59.000Z",
      "credentialSubject": {
        "id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
        "spendingConstraints": {
          "maxAmount": 500000,
          "currency": "INR",
          "allowedCategories": ["cloud_services", "saas_subscription", "compute_gpu"],
          "merchantWhitelist": ["*"]
        }
      },
      "proof": {
        "type": "Ed25519Signature2020",
        "created": "2026-08-23T22:00:00.000Z",
        "verificationMethod": "did:key:z6MkuUserRootWalletKey...#key-1",
        "jws": "eyJhbGciOiJFZERTQSI...detached_jws_signature"
      }
    }
  }
}
```

---

### Step 3: Catalog Request & Response (`CATALOG_REQUEST` / `CATALOG_RESPONSE`)
**State:** `MANDATE_VERIFIED` ➔ `CATALOG_RECEIVED`  
**Direction:** Buyer ➔ Merchant ➔ Buyer (Encrypted)  

**Request:**
```json
{
  "type": "CATALOG_REQUEST",
  "payload": {
    "category": "cloud_services"
  }
}
```

**Response:**
```json
{
  "type": "CATALOG_RESPONSE",
  "payload": {
    "items": [
      {
        "id": "item_gpu_cluster_h100",
        "name": "NVIDIA H100 8-GPU Inference Node (100 hrs)",
        "category": "cloud_services",
        "basePrice": 350000,
        "currency": "INR",
        "stock": 12,
        "metadata": { "region": "ap-south-1", "tier": "enterprise" }
      },
      {
        "id": "item_api_gateway_pro",
        "name": "Ultra-Low Latency API Gateway (1M reqs)",
        "category": "cloud_services",
        "basePrice": 45000,
        "currency": "INR",
        "stock": 999,
        "metadata": { "sla": "99.99%" }
      }
    ]
  }
}
```

---

### Step 4: Purchase Intent (`PURCHASE_INTENT`)
**State:** `CATALOG_RECEIVED` ➔ `INTENT_SENT`  
**Direction:** Buyer ➔ Merchant (Encrypted)  

```json
{
  "type": "PURCHASE_INTENT",
  "payload": {
    "cartId": "cart_7a8b9c0d",
    "items": [
      {
        "itemId": "item_gpu_cluster_h100",
        "quantity": 1,
        "offeredUnitPrice": 320000
      }
    ],
    "negotiationReason": "Volume commitment for Q3 research workload"
  }
}
```

---

### Step 5: Deterministic Quote (`QUOTE_RESPONSE`)
**State:** `INTENT_SENT` ➔ `QUOTE_RECEIVED`  
**Direction:** Merchant ➔ Buyer (Encrypted)  

```json
{
  "type": "QUOTE_RESPONSE",
  "payload": {
    "quoteId": "quote_4f5e6d7c",
    "cartId": "cart_7a8b9c0d",
    "subtotal": 330000,
    "discount": 20000,
    "tax": 59400,
    "totalAmount": 389400,
    "currency": "INR",
    "merchantUpiId": "agentpay.merchant@razorpay",
    "expiresAt": "2026-08-23T22:45:00.000Z",
    "merchantSignature": "eyJhbGciOiJFZERTQSI...merchant_quote_sig",
    "recommendations": [
      {
        "itemId": "item_vector_db_pro",
        "name": "Managed Vector Database Instance (50M Embeddings)",
        "quantity": 1,
        "offeredUnitPrice": 80750,
        "reason": "Frequently co-provisioned with H100 clusters by AI-infra teams."
      }
    ]
  }
}
```

> **Recommendations (v1.1):** the merchant growth agent may attach up to two
> complementary items. They are included **inside the signed `merchantSignature`
> payload**, and prices are recomputed server-side as
> `basePrice × (1 − appliedDiscount)` — the LLM cannot invent margin on
> recommendations either. The buyer accepts at most one via a deterministic
> affordability gate (remaining budget + mandate bounds), triggering a single
> bounded upsell round on a fresh ECDH handshake.
>
> **Conversational entry:** `POST /api/chat` maps natural language onto a
> shopping goal (LLM extractor with offline heuristic fallback) and executes
> Steps 1–7 unchanged; every step mirrors to `/ws/feed`.

---

### Step 6: Signed Transaction Payload (`SIGNED_TRANSACTION`)
**State:** `QUOTE_RECEIVED` ➔ `SIGNED`  
**Direction:** Buyer ➔ Merchant (Encrypted)  

```json
{
  "type": "SIGNED_TRANSACTION",
  "payload": {
    "transactionId": "txn_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "quoteId": "quote_4f5e6d7c",
    "buyerDID": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "merchantDID": "did:key:z6MkmMerchantIdentityKey...",
    "amount": 389400,
    "currency": "INR",
    "merchantUpiId": "agentpay.merchant@razorpay",
    "nonce": "e7b4a20a-81a1-43d9-9528-98e3b2e59e10",
    "timestamp": "2026-08-23T22:31:00.000Z",
    "jwsSignature": "eyJhbGciOiJFZERTQSI...detached_buyer_jws"
  }
}
```

---

### Step 7: Settlement Receipt (`SETTLEMENT_RECEIPT`)
**State:** `SIGNED` ➔ `SETTLED`  
**Direction:** Merchant ➔ Buyer (Encrypted)  

```json
{
  "type": "SETTLEMENT_RECEIPT",
  "payload": {
    "receiptId": "rcpt_987654321",
    "transactionId": "txn_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "razorpayOrderId": "order_RZP9823471029",
    "razorpayPaymentId": "pay_RZP8839201948",
    "amount": 389400,
    "currency": "INR",
    "status": "CAPTURED",
    "uapMandateRef": "uap_circle_mandate_098124",
    "settlementTimestamp": "2026-08-23T22:31:02.000Z",
    "cryptographicAuditDigest": "sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5"
  }
}
```

---

### Step 8: Autonomous Reconciliation Challenge (`RECONCILIATION_CHALLENGE`)
**State:** `SIGNED` ➔ `RECONCILING` (on network timeout / dropped frame)  
**Direction:** Buyer ➔ Merchant (Encrypted)  

```json
{
  "type": "RECONCILIATION_CHALLENGE",
  "payload": {
    "transactionId": "txn_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "quoteId": "quote_4f5e6d7c",
    "originalNonce": "e7b4a20a-81a1-43d9-9528-98e3b2e59e10",
    "timestamp": "2026-08-23T22:31:05.000Z",
    "buyerSignature": "eyJhbGciOiJFZERTQSI...detached_challenge_jws"
  }
}
```

---

### Step 9: Reconciliation Proof & Void Certificate (`RECONCILIATION_PROOF`)
**State:** `RECONCILING` ➔ `SETTLED` (Synced Receipt) OR `RECONCILING` ➔ `ABORTED` (Void Proof)  
**Direction:** Merchant ➔ Buyer (Encrypted)  

**Scenario 1: Payment Succeeded (Synced Receipt)**
```json
{
  "type": "RECONCILIATION_PROOF",
  "payload": {
    "transactionId": "txn_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "status": "SETTLED",
    "settlementReceipt": {
      "type": "SETTLEMENT_RECEIPT",
      "receiptId": "rcpt_987654321",
      "transactionId": "txn_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
      "razorpayOrderId": "order_RZP9823471029",
      "razorpayPaymentId": "pay_RZP8839201948",
      "amount": 389400,
      "currency": "INR",
      "status": "CAPTURED",
      "uapMandateRef": "uap_circle_mandate_098124",
      "settlementTimestamp": "2026-08-23T22:31:02.000Z",
      "cryptographicAuditDigest": "sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5"
    },
    "merchantSignature": "eyJhbGciOiJFZERTQSI...merchant_reconciliation_sig",
    "timestamp": "2026-08-23T22:31:06.000Z"
  }
}
```

**Scenario 2: Payment Voided (Order Never Processed)**
```json
{
  "type": "RECONCILIATION_PROOF",
  "payload": {
    "transactionId": "txn_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "status": "VOIDED",
    "reason": "GATEWAY_TIMEOUT_ORDER_NOT_PROCESSED",
    "merchantSignature": "eyJhbGciOiJFZERTQSI...signed_void_proof",
    "timestamp": "2026-08-23T22:31:06.000Z"
  }
}
```

---

## 4. Edge Guarantee

> *"The LLM does not have direct access to the payment gateway. It only outputs this exact JSON specification, which the FSM validates deterministically before executing the cryptography and network settlement."*

