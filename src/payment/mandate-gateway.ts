import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { computeSha256 } from '../crypto/keys.js';
import type { VerifiableCredential } from '../identity/types.js';
import type {
  TransactionPayloadMessage,
  SettlementReceiptMessage,
} from '../protocol/schemas.js';
import { RazorpayGateway } from './razorpay.js';
import type { UAPProofBundle, RazorpayOrderResult } from './types.js';

export interface ProcessCheckoutParams {
  signedTransaction: TransactionPayloadMessage;
  buyerMandate: VerifiableCredential;
  gateway: RazorpayGateway;
}

/**
 * Submits the cryptographically signed intent and buyer mandate to Razorpay UPI Reserve Pay / UAP.
 */
export async function processAgenticCheckout(
  params: ProcessCheckoutParams
): Promise<{
  receipt: SettlementReceiptMessage;
  bundle: UAPProofBundle;
}> {
  const { signedTransaction, buyerMandate, gateway } = params;

  const vcHash = computeSha256(buyerMandate);
  const jwsHash = computeSha256(signedTransaction.jwsSignature);

  // 1. Create Razorpay order with attached cryptographic audit notes
  const order: RazorpayOrderResult = await gateway.createOrder({
    amount: signedTransaction.amount,
    currency: signedTransaction.currency,
    receipt: `rcpt_${signedTransaction.transactionId.substring(0, 14)}`,
    notes: {
      transactionId: signedTransaction.transactionId,
      buyerDID: signedTransaction.buyerDID,
      merchantDID: signedTransaction.merchantDID,
      vcDigest: `sha256:${vcHash}`,
      jwsDigest: `sha256:${jwsHash}`,
      uapMandateRef: buyerMandate.credentialSubject.uapMandateCircleRef || 'default_uap_ref',
      agenticProtocol: 'AgentPay-UAP-v1.0',
    },
  });

  // 2. Autonomous settlement capture via UPI Reserve Pay (NPCI Circle delegation)
  const { payment, signature } = await gateway.captureAutonomousPayment({
    orderId: order.id,
    amount: signedTransaction.amount,
    userUpiId: buyerMandate.credentialSubject.userUpiId || 'user.agent@okhdfcbank',
    uapMandateCircleRef: buyerMandate.credentialSubject.uapMandateCircleRef || 'uap_mandate_01',
    notes: order.notes,
  });

  // 3. Compute immutable cryptographic audit digest: H(VC || JWS || OrderID || PaymentID)
  const auditData = `${vcHash}:${jwsHash}:${order.id}:${payment.id}:${signedTransaction.nonce}`;
  const auditDigest = `sha256:${crypto.createHash('sha256').update(auditData).digest('hex')}`;

  const receipt: SettlementReceiptMessage = {
    type: 'SETTLEMENT_RECEIPT',
    receiptId: `rcpt_${uuidv4().substring(0, 8)}`,
    transactionId: signedTransaction.transactionId,
    razorpayOrderId: order.id,
    razorpayPaymentId: payment.id,
    amount: signedTransaction.amount,
    currency: signedTransaction.currency,
    status: 'CAPTURED',
    uapMandateRef: buyerMandate.credentialSubject.uapMandateCircleRef || 'uap_mandate_01',
    settlementTimestamp: new Date().toISOString(),
    cryptographicAuditDigest: auditDigest,
  };

  const bundle: UAPProofBundle = {
    buyerDID: signedTransaction.buyerDID,
    merchantDID: signedTransaction.merchantDID,
    transactionId: signedTransaction.transactionId,
    amount: signedTransaction.amount,
    currency: signedTransaction.currency,
    mandateCredential: buyerMandate,
    signedTransaction,
    razorpayOrder: order,
    paymentResult: payment,
    paymentSignature: signature,
    auditTrailDigest: auditDigest,
  };

  return {
    receipt,
    bundle,
  };
}
