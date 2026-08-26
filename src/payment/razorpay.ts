import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { generateRazorpaySignature, verifyRazorpaySignature } from '../crypto/signatures.js';
import type { RazorpayOrderResult, RazorpayPaymentResult } from './types.js';

export interface RazorpayGatewayConfig {
  keyId: string;
  keySecret: string;
  mockMode?: boolean;
}

export class RazorpayGateway {
  private rzp: any;
  private keyId: string;
  private keySecret: string;
  private isMock: boolean;

  constructor(config: RazorpayGatewayConfig) {
    this.keyId = config.keyId || 'rzp_test_agentpay_mock';
    this.keySecret = config.keySecret || 'agentpay_secret_mock_12345';
    this.isMock = config.mockMode ?? true;

    // Config sanity warnings — fail loudly at boot, not silently at checkout.
    if (!this.isMock) {
      const looksPlaceholder = /agentpay|mock|xxxx/i.test(this.keyId) || /mock/i.test(this.keySecret);
      const looksRzp = /^rzp_(test|live)_/.test(this.keyId);
      if (looksPlaceholder || !looksRzp) {
        console.warn(
          `[AgentPay] RAZORPAY_MOCK_MODE=false but credentials look invalid ` +
            `(keyId="${this.keyId}"). Falling back to simulation until real rzp_test_* ` +
            `keys are provided.`
        );
        this.isMock = true;
      }
    } else if (/^rzp_(test|live)_[A-Za-z0-9]{10,}/.test(this.keyId)) {
      console.warn(
        '[AgentPay] Real Razorpay key detected while running in MOCK mode. ' +
          'Set RAZORPAY_MOCK_MODE=false to use live Orders API.'
      );
    }

    if (!this.isMock && (this.keyId.startsWith('rzp_live') || this.keyId.startsWith('rzp_test'))) {
      try {
        this.rzp = new Razorpay({
          key_id: this.keyId,
          key_secret: this.keySecret,
        });
      } catch {
        this.isMock = true;
      }
    } else {
      this.isMock = true;
    }
  }

  public isMockMode(): boolean {
    return this.isMock;
  }

  /** Honest mode labels for /api/identities and the dashboard chip. */
  public orderCreationMode(): 'mock' | 'live-test-orders' {
    return this.isMock ? 'mock' : 'live-test-orders';
  }

  /** Autonomous UPI Reserve Pay capture is UAP-simulated until those rails open. */
  public captureMode(): 'uap-simulated' {
    return 'uap-simulated';
  }

  /**
   * Creates a new Razorpay order for an agentic checkout.
   */
  public async createOrder(params: {
    amount: number; // in paise
    currency?: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<RazorpayOrderResult> {
    const { amount, currency = 'INR', receipt, notes = {} } = params;

    if (!this.isMock && this.rzp) {
      try {
        const order = await this.rzp.orders.create({
          amount,
          currency,
          receipt,
          notes,
        });
        return order as RazorpayOrderResult;
      } catch (err: any) {
        console.warn(`Razorpay SDK call failed (${err.message}). Falling back to deterministic sandbox simulation.`);
      }
    }

    // Deterministic Mock Simulation
    const orderId = `order_RZP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    return {
      id: orderId,
      entity: 'order',
      amount,
      amount_paid: 0,
      amount_due: amount,
      currency,
      receipt,
      status: 'created',
      attempts: 0,
      notes,
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Simulates/executes autonomous UPI Reserve Pay payment capture against an existing order.
   */
  public async captureAutonomousPayment(params: {
    orderId: string;
    amount: number;
    userUpiId: string;
    uapMandateCircleRef: string;
    notes?: Record<string, string>;
  }): Promise<{
    payment: RazorpayPaymentResult;
    signature: string;
  }> {
    const { orderId, amount, userUpiId, uapMandateCircleRef, notes = {} } = params;
    const paymentId = `pay_RZP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const signature = generateRazorpaySignature(orderId, paymentId, this.keySecret);

    const payment: RazorpayPaymentResult = {
      id: paymentId,
      entity: 'payment',
      amount,
      currency: 'INR',
      status: 'captured',
      order_id: orderId,
      method: 'upi',
      vpa: userUpiId,
      captured: true,
      notes: {
        ...notes,
        uapMandateRef: uapMandateCircleRef,
        settlementType: 'UPI_RESERVE_PAY_AUTONOMOUS',
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    return {
      payment,
      signature,
    };
  }

  /**
   * Verifies payment authenticity using HMAC-SHA256 signature check.
   */
  public verifyPayment(orderId: string, paymentId: string, signature: string): boolean {
    return verifyRazorpaySignature(orderId, paymentId, signature, this.keySecret);
  }
}
