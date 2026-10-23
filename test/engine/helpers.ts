import { openDb } from "../../src/db.ts";
import { DEMO_MANDATE } from "../../src/fixtures.ts";
import type { Mandate, Payment } from "../../src/types.ts";

let seq = 0;

export function makePayment(overrides: Partial<Payment> = {}): Payment {
  seq += 1;
  const at = overrides.createdAt ?? new Date().toISOString();
  return {
    id: `pay_test_${seq}`,
    mandateId: DEMO_MANDATE.id,
    recipient: DEMO_MANDATE.allowlist[0]!,
    amount: 1,
    currency: "USDC",
    memo: "test",
    context: null,
    verdict: "approved",
    status: "settled",
    risk: 0,
    checks: [],
    reason: null,
    txHash: null,
    createdAt: at,
    updatedAt: at,
    settledAt: null,
    ...overrides,
  };
}

export function tempDb(mandates: Mandate[] = [DEMO_MANDATE]) {
  const db = openDb(":memory:");
  for (const m of mandates) db.upsertMandate(m);
  return db;
}
