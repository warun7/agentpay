import crypto from 'node:crypto';

export type ProtocolState =
  | 'INIT'
  | 'DID_EXCHANGED'
  | 'SESSION_ESTABLISHED'
  | 'MANDATE_VERIFIED'
  | 'CATALOG_RECEIVED'
  | 'INTENT_SENT'
  | 'QUOTE_RECEIVED'
  | 'SIGNED'
  | 'RECONCILING'
  | 'SETTLED'
  | 'ABORTED'
  | 'ERROR';

export interface StateTransitionEvent {
  step: number;
  fromState: ProtocolState;
  toState: ProtocolState;
  action: string;
  timestamp: string;
  payloadDigest?: string;
  details?: Record<string, any>;
}

export class ProtocolViolationError extends Error {
  public currentState: ProtocolState;
  public attemptedAction: string;

  constructor(currentState: ProtocolState, attemptedAction: string, message: string) {
    super(`[ProtocolViolation] Cannot execute '${attemptedAction}' from state '${currentState}': ${message}`);
    this.name = 'ProtocolViolationError';
    this.currentState = currentState;
    this.attemptedAction = attemptedAction;
  }
}

export class ProtocolStateMachine {
  private currentState: ProtocolState = 'INIT';
  private transitionHistory: StateTransitionEvent[] = [];
  private onTransitionListeners: ((event: StateTransitionEvent) => void)[] = [];

  // Valid state transitions mapping
  private static readonly VALID_TRANSITIONS: Record<ProtocolState, ProtocolState[]> = {
    INIT: ['DID_EXCHANGED', 'ERROR'],
    DID_EXCHANGED: ['SESSION_ESTABLISHED', 'ERROR'],
    SESSION_ESTABLISHED: ['MANDATE_VERIFIED', 'RECONCILING', 'ERROR'],
    MANDATE_VERIFIED: ['CATALOG_RECEIVED', 'ERROR'],
    CATALOG_RECEIVED: ['INTENT_SENT', 'ERROR'],
    INTENT_SENT: ['QUOTE_RECEIVED', 'ERROR'],
    QUOTE_RECEIVED: ['SIGNED', 'ERROR'],
    SIGNED: ['SETTLED', 'RECONCILING', 'ERROR'],
    RECONCILING: ['SETTLED', 'ABORTED', 'ERROR'],
    ABORTED: ['INIT'],
    SETTLED: ['INIT', 'RECONCILING'], // Can reset or enter dispute reconciliation
    ERROR: ['INIT'],
  };



  public getState(): ProtocolState {
    return this.currentState;
  }

  public getHistory(): StateTransitionEvent[] {
    return [...this.transitionHistory];
  }

  public onTransition(listener: (event: StateTransitionEvent) => void): () => void {
    this.onTransitionListeners.push(listener);
    return () => {
      this.onTransitionListeners = this.onTransitionListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Transitions to a new state if valid according to the protocol rules.
   */
  public transition(
    toState: ProtocolState,
    action: string,
    payload?: any,
    details?: Record<string, any>
  ): StateTransitionEvent {
    const allowed = ProtocolStateMachine.VALID_TRANSITIONS[this.currentState] || [];

    if (!allowed.includes(toState)) {
      const error = new ProtocolViolationError(
        this.currentState,
        action,
        `Invalid state transition to '${toState}'. Allowed: [${allowed.join(', ')}]`
      );
      this.transitionToError(action, error.message);
      throw error;
    }

    let payloadDigest: string | undefined;
    if (payload) {
      const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
      payloadDigest = crypto.createHash('sha256').update(str).digest('hex');
    }

    const event: StateTransitionEvent = {
      step: this.transitionHistory.length + 1,
      fromState: this.currentState,
      toState,
      action,
      timestamp: new Date().toISOString(),
      payloadDigest,
      details,
    };

    this.currentState = toState;
    this.transitionHistory.push(event);

    // Notify listeners
    for (const listener of this.onTransitionListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Error in transition listener:', err);
      }
    }

    return event;
  }

  public transitionToError(action: string, reason: string): StateTransitionEvent {
    const event: StateTransitionEvent = {
      step: this.transitionHistory.length + 1,
      fromState: this.currentState,
      toState: 'ERROR',
      action,
      timestamp: new Date().toISOString(),
      details: { reason },
    };

    this.currentState = 'ERROR';
    this.transitionHistory.push(event);

    for (const listener of this.onTransitionListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Error in transition listener:', err);
      }
    }

    return event;
  }
}
