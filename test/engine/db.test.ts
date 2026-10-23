import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monthStart, openDb, type Db } from "../../src/db.ts";
import { ADDR, DEMO_MANDATE } from "../../src/fixtures.ts";
import type { Check } from "../../src/types.ts";
import { makePayment, tempDb } from "./helpers.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

let db: Db;
afterEach(() => db?.close());

describe("schema and mandates", () => {
  test("round-trips a Payment through a temp file DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "asf-db-"));
    try {
      const path = join(dir, "test.db");
      const checks: Check[] = [
        { id: "R4", name: "allowlist", outcome: "block", reason: "Recipient 0xAB…12 is not on the allowlist" },
        { id: "INTENT", name: "intent", outcome: "escalate", reason: "Memo looks unrelated" },
      ];
      const p = makePayment({ amount: 1.234567, checks, context: "ctx", reason: "why", txHash: "0xhash", settledAt: NOW.toISOString(), risk: 42, verdict: "blocked", status: "blocked" });
      const first = openDb(path);
      first.upsertMandate(DEMO_MANDATE);
      first.insertPayment(p);
      first.close();

      db = openDb(path);
      expect(db.getPayment(p.id)).toEqual(p);
      expect(db.getMandate(DEMO_MANDATE.id)).toEqual(DEMO_MANDATE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips a mandate including allowlist and velocity", () => {
    db = tempDb();
    expect(db.getMandate(DEMO_MANDATE.id)).toEqual(DEMO_MANDATE);
    expect(db.listMandates()).toEqual([DEMO_MANDATE]);
  });

  test("upsertMandate updates an existing mandate in place", () => {
    db = tempDb();
    const updated = { ...DEMO_MANDATE, active: false, allowlist: [ADDR.hosting], perTxLimit: 2.5 };
    expect(db.upsertMandate(updated)).toEqual(updated);
    expect(db.listMandates()).toHaveLength(1);
  });

  test("getMandate and getPayment return null for unknown ids", () => {
    db = tempDb();
    expect(db.getMandate("nope")).toBeNull();
    expect(db.getPayment("nope")).toBeNull();
  });

  test("payments require an existing mandate", () => {
    db = tempDb();
    expect(() => db.insertPayment(makePayment({ mandateId: "missing" }))).toThrow();
  });

  test("duplicate payment ids are rejected", () => {
    db = tempDb();
    const p = makePayment();
    db.insertPayment(p);
    expect(() => db.insertPayment(p)).toThrow();
  });

  test("amounts keep 6 decimal precision without float drift", () => {
    db = tempDb();
    for (let i = 0; i < 10; i++) db.insertPayment(makePayment({ amount: 0.1, createdAt: NOW.toISOString() }));
    expect(db.monthSpend(DEMO_MANDATE.id, NOW)).toBe(1);
    const p = db.insertPayment(makePayment({ amount: 0.000001 }));
    expect(p.amount).toBe(0.000001);
  });

  test("text fields survive quotes and unicode", () => {
    db = tempDb();
    const p = makePayment({ memo: `'; DROP TABLE payments; -- "quoted" 💸`, context: "ünïcödé\nnewline" });
    expect(db.insertPayment(p)).toEqual(p);
    expect(db.listPayments()).toHaveLength(1);
  });
});

describe("updatePayment", () => {
  test("patches only given fields", () => {
    db = tempDb();
    const p = db.insertPayment(makePayment({ status: "pending_approval", verdict: "needs_approval" }));
    const updated = db.updatePayment(p.id, { status: "settled", txHash: "0xabc", settledAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    expect(updated).toEqual({ ...p, status: "settled", txHash: "0xabc", settledAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
  });

  test("returns null for unknown id", () => {
    db = tempDb();
    expect(db.updatePayment("nope", { status: "settled" })).toBeNull();
  });
});

describe("listPayments", () => {
  test("filters by mandate and status, newest first, with limit", () => {
    const other = { ...DEMO_MANDATE, id: "mdt_other" };
    db = tempDb([DEMO_MANDATE, other]);
    const a = db.insertPayment(makePayment({ createdAt: minutesAgo(30), status: "settled" }));
    const b = db.insertPayment(makePayment({ createdAt: minutesAgo(20), status: "blocked" }));
    const c = db.insertPayment(makePayment({ createdAt: minutesAgo(10), status: "settled", mandateId: other.id }));

    expect(db.listPayments().map((p) => p.id)).toEqual([c.id, b.id, a.id]);
    expect(db.listPayments({ mandateId: DEMO_MANDATE.id }).map((p) => p.id)).toEqual([b.id, a.id]);
    expect(db.listPayments({ status: "settled" }).map((p) => p.id)).toEqual([c.id, a.id]);
    expect(db.listPayments({ mandateId: DEMO_MANDATE.id, status: "settled" }).map((p) => p.id)).toEqual([a.id]);
    expect(db.listPayments({ limit: 1 }).map((p) => p.id)).toEqual([c.id]);
    expect(db.listPayments({ limit: 0 })).toEqual([]);
  });

  test("same-timestamp payments are ordered by insertion, newest first", () => {
    db = tempDb();
    const at = NOW.toISOString();
    const ids = [1, 2, 3].map(() => db.insertPayment(makePayment({ createdAt: at })).id);
    expect(db.listPayments().map((p) => p.id)).toEqual(ids.reverse());
  });
});

describe("monthSpend", () => {
  test("sums settled and pending payments in the current UTC month only", () => {
    db = tempDb();
    db.insertPayment(makePayment({ amount: 2, status: "settled", createdAt: "2026-10-01T00:00:00.000Z" }));
    db.insertPayment(makePayment({ amount: 3, status: "pending_approval", createdAt: minutesAgo(5) }));
    db.insertPayment(makePayment({ amount: 100, status: "blocked", createdAt: minutesAgo(5) }));
    db.insertPayment(makePayment({ amount: 100, status: "rejected", createdAt: minutesAgo(5) }));
    db.insertPayment(makePayment({ amount: 100, status: "failed", createdAt: minutesAgo(5) }));
    db.insertPayment(makePayment({ amount: 100, status: "settled", createdAt: "2026-09-30T23:59:59.999Z" }));
    expect(db.monthSpend(DEMO_MANDATE.id, NOW)).toBe(5);
  });

  test("is scoped to the mandate and zero when empty", () => {
    const other = { ...DEMO_MANDATE, id: "mdt_other" };
    db = tempDb([DEMO_MANDATE, other]);
    expect(db.monthSpend(DEMO_MANDATE.id, NOW)).toBe(0);
    db.insertPayment(makePayment({ amount: 7, mandateId: other.id, createdAt: minutesAgo(1) }));
    expect(db.monthSpend(DEMO_MANDATE.id, NOW)).toBe(0);
    expect(db.monthSpend(other.id, NOW)).toBe(7);
  });

  test("monthStart is the first instant of the UTC month", () => {
    expect(monthStart(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-01T00:00:00.000Z");
    expect(monthStart(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("recentPayments", () => {
  test("returns attempted payments inside the window, newest first", () => {
    db = tempDb();
    const old = db.insertPayment(makePayment({ createdAt: minutesAgo(11) }));
    const edge = db.insertPayment(makePayment({ createdAt: minutesAgo(10) }));
    const pending = db.insertPayment(makePayment({ createdAt: minutesAgo(5), status: "pending_approval" }));
    const failed = db.insertPayment(makePayment({ createdAt: minutesAgo(4), status: "failed" }));
    db.insertPayment(makePayment({ createdAt: minutesAgo(3), status: "blocked" }));
    db.insertPayment(makePayment({ createdAt: minutesAgo(2), status: "rejected" }));
    const ids = db.recentPayments(DEMO_MANDATE.id, 10, NOW).map((p) => p.id);
    expect(ids).toEqual([failed.id, pending.id, edge.id]);
    expect(ids).not.toContain(old.id);
  });
});

describe("historyTo", () => {
  test("returns settled payments to the recipient, case-insensitively", () => {
    db = tempDb();
    const settled = db.insertPayment(makePayment({ recipient: ADDR.hosting, status: "settled" }));
    db.insertPayment(makePayment({ recipient: ADDR.hosting, status: "blocked" }));
    db.insertPayment(makePayment({ recipient: ADDR.hosting, status: "pending_approval" }));
    db.insertPayment(makePayment({ recipient: ADDR.apiVendor, status: "settled" }));
    expect(db.historyTo(DEMO_MANDATE.id, ADDR.hosting.toUpperCase().replace("0X", "0x")).map((p) => p.id)).toEqual([settled.id]);
    expect(db.historyTo(DEMO_MANDATE.id, ADDR.attacker)).toEqual([]);
  });
});
