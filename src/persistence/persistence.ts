import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Durable demo ledger (Priority 5).
 *
 * Uses Node's built-in `node:sqlite` (WAL mode) — zero npm dependencies.
 * Falls back to an in-memory store automatically when the runtime lacks
 * node:sqlite or PERSISTENCE=memory is set. All idempotency/audit/spend
 * claims survive process restarts when SQLite is active.
 */

export interface TransactionRow {
  transaction_id: string;
  nonce: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  status: string;
  receipt_json: string | null;
  bundle_json: string | null;
  recommendations_offered?: number;
  is_upsell_round?: number;
  created_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
}

export interface AuditEventRow {
  transaction_id: string;
  step: number;
  from_state: string;
  to_state: string;
  action: string;
  payload_digest: string | null;
  details_json: string | null;
  timestamp: string;
}

export interface SpendRow {
  subject_did: string;
  amount: number;
  timestamp: number;
}

export interface PersistenceStore {
  readonly kind: 'sqlite' | 'memory';
  saveTransaction(row: TransactionRow): void;
  loadTransactions(): TransactionRow[];
  markConfirmed(transactionId: string, confirmedAt: string, confirmedBy: string): void;
  saveWebhook(dedupeKey: string, eventName: string, orderId: string, paymentId: string): 'new' | 'duplicate';
  loadWebhookKeys(): string[];
  recordSpend(subjectDID: string, amount: number, timestampMs: number): void;
  loadSpendSince(sinceMs: number): SpendRow[];
  saveAuditEvents(events: AuditEventRow[]): void;
  loadAuditEvents(transactionId: string): AuditEventRow[];
  close?(): void;
}

// ── Memory fallback ──────────────────────────────────────────────────────────

export class MemoryPersistence implements PersistenceStore {
  readonly kind = 'memory' as const;
  private txns = new Map<string, TransactionRow>();
  private webhooks = new Set<string>();
  private spend: SpendRow[] = [];
  private audit = new Map<string, AuditEventRow[]>();

  saveTransaction(row: TransactionRow): void {
    this.txns.set(row.transaction_id, row);
    if (row.nonce) this.txns.set(`nonce:${row.nonce}`, row);
    if (row.razorpay_order_id) this.txns.set(`order:${row.razorpay_order_id}`, row);
  }
  loadTransactions(): TransactionRow[] {
    return [...new Set(this.txns.values())];
  }
  markConfirmed(transactionId: string, confirmedAt: string, confirmedBy: string): void {
    const row = this.txns.get(transactionId);
    if (row) { row.confirmed_at = confirmedAt; row.confirmed_by = confirmedBy; }
  }
  saveWebhook(dedupeKey: string): 'new' | 'duplicate' {
    if (this.webhooks.has(dedupeKey)) return 'duplicate';
    this.webhooks.add(dedupeKey);
    return 'new';
  }
  loadWebhookKeys(): string[] { return [...this.webhooks]; }
  recordSpend(subjectDID: string, amount: number, timestampMs: number): void {
    this.spend.push({ subject_did: subjectDID, amount, timestamp: timestampMs });
  }
  loadSpendSince(sinceMs: number): SpendRow[] {
    return this.spend.filter((r) => r.timestamp > sinceMs);
  }
  saveAuditEvents(events: AuditEventRow[]): void {
    for (const e of events) {
      const list = this.audit.get(e.transaction_id) ?? [];
      list.push(e);
      this.audit.set(e.transaction_id, list);
    }
  }
  loadAuditEvents(transactionId: string): AuditEventRow[] {
    return this.audit.get(transactionId) ?? [];
  }
}

// ── SQLite (node:sqlite, WAL) ────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  nonce TEXT UNIQUE,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  status TEXT NOT NULL,
  receipt_json TEXT,
  bundle_json TEXT,
  recommendations_offered INTEGER DEFAULT 0,
  is_upsell_round INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  transaction_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_digest TEXT,
  details_json TEXT,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (transaction_id, step)
);
CREATE TABLE IF NOT EXISTS processed_webhooks (
  dedupe_key TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  order_id TEXT,
  payment_id TEXT,
  first_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spend_ledger (
  subject_did TEXT NOT NULL,
  amount INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_did_ts ON spend_ledger(subject_did, timestamp);
`;

export class SqlitePersistence implements PersistenceStore {
  readonly kind = 'sqlite' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath: string) {
    // ESM-safe lazy load of node:sqlite (keeps non-Node-22+ runtimes working
    // in memory mode instead of crashing at import time).
    const require_ = createRequire(import.meta.url);
    const { DatabaseSync } = require_('node:sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  saveTransaction(row: TransactionRow): void {
    this.db.prepare(
      `INSERT INTO transactions
       (transaction_id, nonce, razorpay_order_id, razorpay_payment_id, status,
        receipt_json, bundle_json, recommendations_offered, is_upsell_round,
        created_at, confirmed_at, confirmed_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(transaction_id) DO UPDATE SET
         confirmed_at=excluded.confirmed_at, confirmed_by=excluded.confirmed_by,
         status=excluded.status`
    ).run(
      row.transaction_id, row.nonce, row.razorpay_order_id, row.razorpay_payment_id,
      row.status, row.receipt_json, row.bundle_json,
      row.recommendations_offered ?? 0, row.is_upsell_round ? 1 : 0,
      row.created_at, row.confirmed_at, row.confirmed_by
    );
  }

  loadTransactions(): TransactionRow[] {
    return this.db.prepare('SELECT * FROM transactions').all() as TransactionRow[];
  }

  markConfirmed(transactionId: string, confirmedAt: string, confirmedBy: string): void {
    this.db.prepare(
      'UPDATE transactions SET confirmed_at=?, confirmed_by=? WHERE transaction_id=?'
    ).run(confirmedAt, confirmedBy, transactionId);
  }

  saveWebhook(dedupeKey: string, eventName: string, orderId: string, paymentId: string): 'new' | 'duplicate' {
    try {
      this.db.prepare(
        'INSERT INTO processed_webhooks (dedupe_key, event_name, order_id, payment_id, first_seen_at) VALUES (?,?,?,?,?)'
      ).run(dedupeKey, eventName, orderId, paymentId, new Date().toISOString());
      return 'new';
    } catch {
      return 'duplicate'; // PRIMARY KEY violation
    }
  }

  loadWebhookKeys(): string[] {
    return (this.db.prepare('SELECT dedupe_key FROM processed_webhooks').all() as any[])
      .map((r) => r.dedupe_key);
  }

  recordSpend(subjectDID: string, amount: number, timestampMs: number): void {
    this.db.prepare(
      'INSERT INTO spend_ledger (subject_did, amount, timestamp) VALUES (?,?,?)'
    ).run(subjectDID, amount, timestampMs);
  }

  loadSpendSince(sinceMs: number): SpendRow[] {
    return this.db.prepare(
      'SELECT subject_did, amount, timestamp FROM spend_ledger WHERE timestamp > ?'
    ).all(sinceMs) as SpendRow[];
  }

  saveAuditEvents(events: AuditEventRow[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO audit_events
       (transaction_id, step, from_state, to_state, action, payload_digest, details_json, timestamp)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const e of events) {
      stmt.run(e.transaction_id, e.step, e.from_state, e.to_state, e.action,
        e.payload_digest, e.details_json, e.timestamp);
    }
  }

  loadAuditEvents(transactionId: string): AuditEventRow[] {
    return this.db.prepare(
      'SELECT * FROM audit_events WHERE transaction_id=? ORDER BY step'
    ).all(transactionId) as AuditEventRow[];
  }

  close(): void {
    this.db?.close();
  }
}

/**
 * Factory honours PERSISTENCE env:
 *   'memory' → always memory
 *   otherwise → SQLite at SQLITE_PATH (default ./agentpay.db),
 *               silently degrading to memory when node:sqlite is unavailable.
 */
export function createPersistenceFromEnv(): PersistenceStore {
  if (process.env.PERSISTENCE === 'memory') return new MemoryPersistence();
  try {
    return new SqlitePersistence(process.env.SQLITE_PATH || './agentpay.db');
  } catch (err: any) {
    console.warn(`[AgentPay] SQLite unavailable (${err.message}) — running with in-memory ledger.`);
    return new MemoryPersistence();
  }
}
