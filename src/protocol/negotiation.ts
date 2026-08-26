import { v4 as uuidv4 } from 'uuid';
import { signDetachedJWS, verifyCompactJWS, signCompactJWS } from '../crypto/signatures.js';
import { computeSha256 } from '../crypto/keys.js';
import type { JWKKey } from '../crypto/types.js';import type { VerifiableCredential } from '../identity/types.js';
import { checkMandateBounds } from '../identity/credentials.js';
import type {
  CatalogItem,
  PurchaseIntentMessage,
  QuoteMessage,
  RecommendationMessage,
  TransactionPayloadMessage,
} from './schemas.js';

export interface GenerateQuoteParams {
  intent: PurchaseIntentMessage;
  catalog: CatalogItem[];
  merchantIdentity: {
    did: string;
    signingPrivateKeyJwk: JWKKey;
    upiId: string;
  };
  discountPercentage?: number;
  taxPercentage?: number;
  /** Growth-agent attachments — included INSIDE the signed payload. */
  recommendations?: RecommendationMessage[];
}

/**
 * Merchant Agent generates a deterministic, cryptographically signed price quote for a purchase intent.
 */
export async function generateQuote(params: GenerateQuoteParams): Promise<QuoteMessage> {
  const {
    intent,
    catalog,
    merchantIdentity,
    discountPercentage = 0.05, // 5% default discount for agent commerce
    taxPercentage = 0.18, // 18% standard GST
    recommendations,
  } = params;

  let subtotal = 0;
  const itemSummary: NonNullable<QuoteMessage['itemSummary']> = [];

  for (const requested of intent.items) {
    const item = catalog.find((c) => c.id === requested.itemId);
    if (!item) {
      throw new Error(`Catalog item '${requested.itemId}' not found`);
    }
    if (item.stock < requested.quantity) {
      throw new Error(`Insufficient stock for item '${item.name}'`);
    }

    // Determine unit price (honoring agreed negotiated bounds if reasonable)
    let unitPrice = item.basePrice;
    if (requested.offeredUnitPrice && requested.offeredUnitPrice >= item.basePrice * 0.85) {
      unitPrice = requested.offeredUnitPrice;
    }

    const lineTotal = unitPrice * requested.quantity;
    subtotal += lineTotal;

    itemSummary.push({
      itemId: item.id,
      name: item.name,
      quantity: requested.quantity,
      unitPrice,
      lineTotal,
    });
  }

  const discount = Math.round(subtotal * discountPercentage);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * taxPercentage);
  const totalAmount = taxable + tax;

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min validity
  const quoteId = `quote_${uuidv4().substring(0, 8)}`;

  const quotePayload: any = {
    quoteId,
    cartId: intent.cartId,
    subtotal,
    discount,
    tax,
    totalAmount,
    currency: 'INR',
    merchantUpiId: merchantIdentity.upiId,
    expiresAt,
    itemSummary,
  };

  if (recommendations && recommendations.length > 0) {
    quotePayload.recommendations = recommendations;
  }

  // Sign quote with Merchant's Ed25519 private key
  const merchantSignature = await signCompactJWS(
    quotePayload,
    merchantIdentity.signingPrivateKeyJwk,
    { kid: `${merchantIdentity.did}#key-1` }
  );

  return {
    type: 'QUOTE_RESPONSE',
    ...quotePayload,
    merchantSignature,
  };
}

/**
 * Buyer-side verification that a received quote was signed by the merchant's
 * Ed25519 key AND that every visible field matches the signed payload.
 *
 * Reconstructs the exact payload generateQuote() signs — everything except
 * `type` and `merchantSignature` — then compares field-by-field so a MITM
 * cannot swap amounts, UPI IDs, or recommendations without detection.
 */
export async function verifyQuoteSignature(
  quote: QuoteMessage,
  merchantPublicKeyJwk: JWKKey
): Promise<{ valid: boolean; reason?: string }> {
  if (!quote.merchantSignature || quote.merchantSignature === 'n/a') {
    return { valid: false, reason: 'missing merchant signature' };
  }

  let payload: any;
  try {
    ({ payload } = await verifyCompactJWS<any>(quote.merchantSignature, merchantPublicKeyJwk));
  } catch (err: any) {
    return { valid: false, reason: `signature verification failed: ${err.message}` };
  }

  const scalarFields = [
    'quoteId', 'cartId', 'subtotal', 'discount', 'tax',
    'totalAmount', 'currency', 'merchantUpiId', 'expiresAt',
  ] as const;
  for (const f of scalarFields) {
    if (payload[f] !== (quote as any)[f]) {
      return { valid: false, reason: `signed field mismatch on '${f}': payload=${JSON.stringify(payload[f])} vs visible=${JSON.stringify((quote as any)[f])}` };
    }
  }

  // Deep-compare structural fields (itemSummary is always present from generateQuote)
  const deepFields = ['itemSummary', 'recommendations'] as const;
  for (const f of deepFields) {
    const signedVal = JSON.stringify(payload[f] ?? null);
    const visibleVal = JSON.stringify((quote as any)[f] ?? null);
    if (signedVal !== visibleVal) {
      return { valid: false, reason: `signed field mismatch on '${f}'` };
    }
  }

  return { valid: true };
}

/**
 * Merchant-side completeness check: EVERY settlement-affecting field in the
 * visible signed transaction must match the JWS-verified payload, and the
 * transaction must be addressed to THIS merchant. Runs after signature
 * verification — catches payload/visibility desyncs even with a valid JWS.
 */
export function assertSignedTransactionMatchesPayload(
  signedTx: TransactionPayloadMessage,
  verifiedPayload: Record<string, unknown>,
  expectedMerchantDID: string
): void {
  const fields = [
    'transactionId', 'quoteId', 'buyerDID', 'merchantDID',
    'amount', 'currency', 'merchantUpiId', 'nonce', 'timestamp',
  ] as const;

  for (const f of fields) {
    if ((signedTx as any)[f] !== verifiedPayload[f]) {
      throw new Error(
        `Signed transaction field mismatch on '${f}': ` +
        `payload=${JSON.stringify(verifiedPayload[f])} vs visible=${JSON.stringify((signedTx as any)[f])}`
      );
    }
  }

  if (signedTx.merchantDID !== expectedMerchantDID) {
    throw new Error(
      `Transaction addressed to wrong merchant: ${signedTx.merchantDID} (this agent: ${expectedMerchantDID})`
    );
  }
}

/**
 * Buyer Agent evaluates a received quote against its delegated Verifiable Credential mandate.
 */
export function evaluateQuoteAgainstMandate(
  quote: QuoteMessage,
  mandate: VerifiableCredential,
  category: string,
  merchantDID: string
): {
  approved: boolean;
  reason?: string;
} {
  // 1. Check expiration
  if (Date.now() > new Date(quote.expiresAt).getTime()) {
    return { approved: false, reason: 'Quote has expired' };
  }

  // 2. Check deterministic spending mandate bounds (currency included)
  const bounds = checkMandateBounds(mandate, quote.totalAmount, category, merchantDID, quote.currency);
  if (!bounds.allowed) {
    return { approved: false, reason: bounds.reason };
  }

  return { approved: true };
}

/**
 * Buyer Agent creates and signs the final transaction commitment payload.
 */
export async function signTransactionPayload(
  quote: QuoteMessage,
  buyerIdentity: {
    did: string;
    signingPrivateKeyJwk: JWKKey;
  },
  merchantDID: string
): Promise<TransactionPayloadMessage> {
  const transactionId = `txn_${uuidv4()}`;
  const nonce = uuidv4();
  const timestamp = new Date().toISOString();

  const unsignedBody = {
    transactionId,
    quoteId: quote.quoteId,
    buyerDID: buyerIdentity.did,
    merchantDID,
    amount: quote.totalAmount,
    currency: quote.currency,
    merchantUpiId: quote.merchantUpiId,
    nonce,
    timestamp,
  };

  // Sign with Buyer's Ed25519 private key
  const { jws } = await signDetachedJWS(unsignedBody, buyerIdentity.signingPrivateKeyJwk);

  return {
    type: 'SIGNED_TRANSACTION',
    ...unsignedBody,
    jwsSignature: jws,
  };
}

/**
 * Buyer Agent constructs and signs a Reconciliation Challenge following a dropped connection or timeout.
 */
export async function createReconciliationChallenge(
  transactionId: string,
  quoteId: string,
  originalNonce: string,
  buyerIdentity: {
    did: string;
    signingPrivateKeyJwk: JWKKey;
  }
): Promise<{
  type: 'RECONCILIATION_CHALLENGE';
  transactionId: string;
  quoteId: string;
  originalNonce: string;
  timestamp: string;
  buyerSignature: string;
}> {
  const timestamp = new Date().toISOString();
  const challengeBody = {
    transactionId,
    quoteId,
    originalNonce,
    buyerDID: buyerIdentity.did,
    timestamp,
  };

  const { jws } = await signDetachedJWS(challengeBody, buyerIdentity.signingPrivateKeyJwk);

  return {
    type: 'RECONCILIATION_CHALLENGE',
    transactionId,
    quoteId,
    originalNonce,
    timestamp,
    buyerSignature: jws,
  };
}

/**
 * Merchant Agent creates and signs a cryptographic Void Proof when a transaction failed or never cleared the gateway.
 */
export async function createVoidProof(
  transactionId: string,
  reason: string,
  merchantIdentity: {
    did: string;
    signingPrivateKeyJwk: JWKKey;
  }
): Promise<{
  type: 'RECONCILIATION_PROOF';
  transactionId: string;
  status: 'VOIDED';
  reason: string;
  merchantSignature: string;
  timestamp: string;
}> {
  const timestamp = new Date().toISOString();
  const voidBody = {
    transactionId,
    status: 'VOIDED' as const,
    reason,
    merchantDID: merchantIdentity.did,
    timestamp,
  };

  const merchantSignature = await signCompactJWS(
    voidBody,
    merchantIdentity.signingPrivateKeyJwk,
    { kid: `${merchantIdentity.did}#key-1` }
  );

  return {
    type: 'RECONCILIATION_PROOF',
    transactionId,
    status: 'VOIDED',
    reason,
    merchantSignature,
    timestamp,
  };
}

