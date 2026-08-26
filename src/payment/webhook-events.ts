import { EventEmitter } from 'node:events';

/**
 * Unified settlement-confirmation event bus.
 *
 * ONE code path confirms captures, regardless of transport origin:
 *   - MOCK/UAP-simulated mode: the gateway emits a synthetic
 *     `payment.captured` internally immediately after simulated capture.
 *   - LIVE test-mode: Razorpay delivers a real signed webhook to
 *     POST /api/webhooks/razorpay, which routes into this same bus.
 *
 * Downstream subscribers (settlement confirmer, dashboard WS feed, audit)
 * cannot tell the difference — which is the point.
 */

export interface PaymentCapturedEvent {
  kind: 'payment.captured';
  source: 'internal-synthetic' | 'razorpay-webhook';
  razorpayOrderId: string;
  razorpayPaymentId: string;
  amountPaise?: number;
  transactionId?: string;
  timestamp: string;
}

export interface PaymentFailedEvent {
  kind: 'payment.failed';
  source: 'internal-synthetic' | 'razorpay-webhook';
  razorpayOrderId: string;
  reason: string;
  timestamp: string;
}

export type PaymentBusEvent = PaymentCapturedEvent | PaymentFailedEvent;

class PaymentEventBus extends EventEmitter {
  /** Emits with guaranteed async dispatch safety (no listener throw kills caller). */
  publish(event: PaymentBusEvent): void {
    this.emit('payment', event);
  }

  subscribe(handler: (event: PaymentBusEvent) => void): () => void {
    this.on('payment', handler);
    return () => this.off('payment', handler);
  }
}

const globalForBus = globalThis as unknown as { __agentPayPaymentBus?: PaymentEventBus };

/** Process-wide singleton so gateway, agents, and HTTP layer share one bus. */
export function paymentBus(): PaymentEventBus {
  if (!globalForBus.__agentPayPaymentBus) {
    globalForBus.__agentPayPaymentBus = new PaymentEventBus();
    globalForBus.__agentPayPaymentBus.setMaxListeners(50);
  }
  return globalForBus.__agentPayPaymentBus;
}
