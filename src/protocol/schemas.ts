import { z } from 'zod';

/**
 * Zod Schemas for all AgentPay Wire Protocol Payloads.
 * This acts as the deterministic firewall protecting the payment pipeline from LLM hallucinations.
 */

// 1. DID Exchange Schema
export const DIDExchangeSchema = z.object({
  type: z.literal('DID_EXCHANGE'),
  agentRole: z.enum(['buyer', 'merchant']),
  did: z.string().startsWith('did:key:'),
  didDocument: z.object({
    '@context': z.array(z.string()),
    id: z.string().startsWith('did:key:'),
    verificationMethod: z.array(
      z.object({
        id: z.string(),
        type: z.enum(['Ed25519VerificationKey2020', 'X25519KeyAgreementKey2020']),
        controller: z.string(),
        publicKeyJwk: z.object({
          kty: z.literal('OKP'),
          crv: z.enum(['Ed25519', 'X25519']),
          x: z.string(),
        }),
      })
    ),
    authentication: z.array(z.string()),
    assertionMethod: z.array(z.string()),
    keyAgreement: z.array(
      z.object({
        id: z.string(),
        type: z.literal('X25519KeyAgreementKey2020'),
        controller: z.string(),
        publicKeyJwk: z.object({
          kty: z.literal('OKP'),
          crv: z.literal('X25519'),
          x: z.string(),
        }),
      })
    ),
  }),
});

// 2. Mandate Presentation Schema
export const MandatePresentationSchema = z.object({
  type: z.literal('MANDATE_PRESENTATION'),
  verifiableCredential: z.object({
    '@context': z.array(z.string()),
    id: z.string(),
    type: z.array(z.string()),
    issuer: z.string().startsWith('did:key:'),
    issuanceDate: z.string().datetime(),
    expirationDate: z.string().datetime(),
    credentialSubject: z.object({
      id: z.string().startsWith('did:key:'),
      spendingConstraints: z.object({
        maxAmount: z.number().positive(),
        currency: z.string().min(3).max(3),
        allowedCategories: z.array(z.string()),
        merchantWhitelist: z.array(z.string()),
        dailyLimit: z.number().optional(),
      }),
      userUpiId: z.string().optional(),
      uapMandateCircleRef: z.string().optional(),
    }),
    proof: z.object({
      type: z.enum(['Ed25519Signature2020', 'JsonWebSignature2020']),
      created: z.string(),
      verificationMethod: z.string(),
      jws: z.string(),
    }),
  }),
});

// 3. Catalog Request Schema
export const CatalogRequestSchema = z.object({
  type: z.literal('CATALOG_REQUEST'),
  category: z.string().optional(),
  maxPrice: z.number().positive().optional(),
});

// 4. Catalog Item & Response Schema
export const CatalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  basePrice: z.number().positive(), // in paise (minor units) e.g. 350000 = ₹3500.00
  currency: z.string().default('INR'),
  stock: z.number().int().nonnegative(),
  description: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

/**
 * Merchant growth agent: complementary/tier-up items attached to a quote.
 * Prices are bundle-discounted by the SAME clamped discount applied to the
 * primary line — recommendations can never invent their own margin.
 */
export const RecommendationSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  offeredUnitPrice: z.number().positive(),
  reason: z.string().max(300),
});

export type RecommendationMessage = z.infer<typeof RecommendationSchema>;

export const CatalogResponseSchema = z.object({
  type: z.literal('CATALOG_RESPONSE'),
  items: z.array(CatalogItemSchema),
  merchantName: z.string(),
  timestamp: z.string().datetime(),
});

// 5. Purchase Intent Schema
export const PurchaseIntentItemSchema = z.object({
  itemId: z.string(),
  quantity: z.number().int().positive(),
  offeredUnitPrice: z.number().positive().optional(),
});

export const PurchaseIntentSchema = z.object({
  type: z.literal('PURCHASE_INTENT'),
  cartId: z.string(),
  items: z.array(PurchaseIntentItemSchema).min(1),
  negotiationReason: z.string().optional(),
});

// 6. Quote Response Schema
export const QuoteSchema = z.object({
  type: z.literal('QUOTE_RESPONSE'),
  quoteId: z.string(),
  cartId: z.string(),
  subtotal: z.number().positive(),
  discount: z.number().nonnegative(),
  tax: z.number().nonnegative(),
  totalAmount: z.number().positive(), // in paise
  currency: z.string().default('INR'),
  merchantUpiId: z.string(),
  expiresAt: z.string().datetime(),
  merchantSignature: z.string(), // JWS signature from Merchant Agent
  itemSummary: z.array(
    z.object({
      itemId: z.string(),
      name: z.string(),
      quantity: z.number(),
      unitPrice: z.number(),
      lineTotal: z.number(),
    })
  ).optional(),
  recommendations: z.array(RecommendationSchema).max(2).optional(),
});

// 7. Signed Transaction Payload Schema (Buyer Agent Commitment)
export const TransactionPayloadSchema = z.object({
  type: z.literal('SIGNED_TRANSACTION'),
  transactionId: z.string(),
  quoteId: z.string(),
  buyerDID: z.string().startsWith('did:key:'),
  merchantDID: z.string().startsWith('did:key:'),
  amount: z.number().positive(),
  currency: z.string().default('INR'),
  merchantUpiId: z.string(),
  nonce: z.string().uuid(),
  timestamp: z.string().datetime(),
  jwsSignature: z.string(), // Detached JWS signed by Buyer Agent Ed25519 key
});

// 8. Settlement Receipt Schema
export const SettlementReceiptSchema = z.object({
  type: z.literal('SETTLEMENT_RECEIPT'),
  receiptId: z.string(),
  transactionId: z.string(),
  razorpayOrderId: z.string(),
  razorpayPaymentId: z.string(),
  amount: z.number().positive(),
  currency: z.string().default('INR'),
  status: z.enum(['CAPTURED', 'AUTHORIZED', 'FAILED']),
  uapMandateRef: z.string(),
  settlementTimestamp: z.string().datetime(),
  cryptographicAuditDigest: z.string(), // SHA-256 link of VC + JWS + Order
});

// 9. Reconciliation Challenge Schema (Buyer -> Merchant Dispute Loop)
export const ReconciliationChallengeSchema = z.object({
  type: z.literal('RECONCILIATION_CHALLENGE'),
  transactionId: z.string(),
  quoteId: z.string(),
  originalNonce: z.string().uuid(),
  timestamp: z.string().datetime(),
  buyerSignature: z.string(), // Detached JWS signed by Buyer Agent Ed25519 key
});

// 10. Reconciliation Proof Schema (Merchant -> Buyer Resolution)
export const ReconciliationProofSchema = z.object({
  type: z.literal('RECONCILIATION_PROOF'),
  transactionId: z.string(),
  status: z.enum(['SETTLED', 'VOIDED']),
  settlementReceipt: SettlementReceiptSchema.optional(),
  reason: z.string().optional(),
  merchantSignature: z.string(), // Ed25519 signed proof/void certificate
  timestamp: z.string().datetime(),
});

// 11. Error Payload Schema
export const ErrorPayloadSchema = z.object({
  type: z.literal('PROTOCOL_ERROR'),
  code: z.string(),
  message: z.string(),
  state: z.string(),
  timestamp: z.string().datetime(),
});

// Type inference
export type DIDExchangeMessage = z.infer<typeof DIDExchangeSchema>;
export type MandatePresentationMessage = z.infer<typeof MandatePresentationSchema>;
export type CatalogRequestMessage = z.infer<typeof CatalogRequestSchema>;
export type CatalogResponseMessage = z.infer<typeof CatalogResponseSchema>;
export type CatalogItem = z.infer<typeof CatalogItemSchema>;
export type PurchaseIntentMessage = z.infer<typeof PurchaseIntentSchema>;
export type QuoteMessage = z.infer<typeof QuoteSchema>;
export type TransactionPayloadMessage = z.infer<typeof TransactionPayloadSchema>;
export type SettlementReceiptMessage = z.infer<typeof SettlementReceiptSchema>;
export type ReconciliationChallengeMessage = z.infer<typeof ReconciliationChallengeSchema>;
export type ReconciliationProofMessage = z.infer<typeof ReconciliationProofSchema>;
export type ErrorPayloadMessage = z.infer<typeof ErrorPayloadSchema>;

