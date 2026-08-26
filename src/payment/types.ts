import type { VerifiableCredential } from '../identity/types.js';
import type { TransactionPayloadMessage, SettlementReceiptMessage } from '../protocol/schemas.js';

export interface RazorpayOrderResult {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: 'created' | 'attempted' | 'paid';
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

export interface RazorpayPaymentResult {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'captured' | 'authorized' | 'failed';
  order_id: string;
  method: 'upi' | 'card' | 'netbanking';
  vpa?: string;
  captured: boolean;
  notes: Record<string, string>;
  created_at: number;
}

export interface UAPProofBundle {
  buyerDID: string;
  merchantDID: string;
  transactionId: string;
  amount: number;
  currency: string;
  mandateCredential: VerifiableCredential;
  signedTransaction: TransactionPayloadMessage;
  razorpayOrder: RazorpayOrderResult;
  paymentResult?: RazorpayPaymentResult;
  paymentSignature?: string;
  auditTrailDigest: string;
}
