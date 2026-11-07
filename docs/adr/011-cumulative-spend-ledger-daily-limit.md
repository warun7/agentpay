# ADR-011: Cumulative Spend Ledger for Daily Limit Enforcement

**Status:** Accepted  
**Date:** 2026-08-25  
**Deciders:** AgentPay Risk & Mandate Compliance Team  

## Context

The `SpendingConstraints` type defines an optional `dailyLimit` field, and the Zod schema validates its presence — but the `checkMandateBounds` function never read it. An autonomous buyer agent could execute unlimited transactions per day, each individually under `maxAmount`, effectively draining a user's account without tripping any guardrail.

For agent-to-agent commerce where transactions are fully autonomous, the daily aggregate limit is the primary safety net against runaway agents. A single per-transaction cap is insufficient because:
- An agent making 100 purchases of ₹4,999 each (under a ₹5,000 mandate) would spend ₹499,900 in a day.
- The user has no human-in-the-loop approval step to catch this.

## Decision

We implement a **`SpendLedger` singleton** that tracks per-subject-DID cumulative spend within a rolling 24-hour window:

1. `SpendLedger.getInstance().getDailySpend(subjectDID)` returns the sum of all recorded spends within the last 24 hours for a given agent DID.
2. `checkMandateBounds` now checks `currentDailySpend + requestedAmount > dailyLimit` as a fourth validation step (after maxAmount, category, and merchant whitelist).
3. After a successful settlement, the caller records the spend via `ledger.recordSpend(subjectDID, amount)`.
4. Expired entries (older than 24 hours) are lazily pruned on read.

## Consequences

### Positive
- **Runaway agent prevention:** An autonomous buyer agent that makes 100 valid micro-purchases per day is now bounded by the aggregate daily ceiling.
- **Zero config for existing mandates:** When `dailyLimit` is undefined, the check is skipped — backward compatible with all existing VCs.
- **Testable in isolation:** `SpendLedger.reset()` allows clean test setup without cross-test contamination.

### Negative / Trade-offs
- **In-memory singleton:** Does not persist across process restarts and is not shared across horizontally scaled instances. Acceptable for a single instance; production would use Redis with TTL-based expiration.
- **Lazy pruning:** Expired entries are only cleaned when `getDailySpend` is called, not proactively. Memory impact is negligible at current traffic volumes.
