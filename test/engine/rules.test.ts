import { describe, expect, test } from "bun:test";
import { r1Active, r2NotExpired, r3WellFormed, r4Allowlist, r5PerTx, r6Monthly, r7Velocity, r8Threshold, runRules, type RuleCtx } from "../../src/engine/rules.ts";
import { ADDR, DEMO_MANDATE, REQUESTS } from "../../src/fixtures.ts";
import type { Mandate, PaymentRequest } from "../../src/types.ts";
import { makePayment } from "./helpers.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function ctx(over: { mandate?: Partial<Mandate>; req?: Partial<PaymentRequest> } & Partial<Omit<RuleCtx, "mandate" | "req">> = {}): RuleCtx {
  const { mandate, req, ...rest } = over;
  return {
    mandate: { ...DEMO_MANDATE, ...mandate },
    req: { ...REQUESTS.clean, ...req },
    monthSpend: 0,
    recent: [],
    history: [],
    now: NOW,
    ...rest,
  };
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("R1 mandate active", () => {
  test("passes when active", () => expect(r1Active(ctx()).outcome).toBe("pass"));
  test("blocks when paused", () => {
    const c = r1Active(ctx({ mandate: { active: false } }));
    expect(c).toEqual({ id: "R1", name: "mandate_active", outcome: "block", reason: "Mandate is paused" });
  });
});

describe("R2 mandate not expired", () => {
  test("passes before expiry", () => expect(r2NotExpired(ctx()).outcome).toBe("pass"));
  test("blocks after expiry", () => {
    const c = r2NotExpired(ctx({ mandate: { expiresAt: "2026-10-01T00:00:00.000Z" } }));
    expect(c.outcome).toBe("block");
    expect(c.reason).toBe("Mandate expired on 2026-10-01");
  });
  test("blocks exactly at expiry", () => {
    expect(r2NotExpired(ctx({ mandate: { expiresAt: NOW.toISOString() } })).outcome).toBe("block");
  });
  test("passes one ms before expiry", () => {
    expect(r2NotExpired(ctx({ mandate: { expiresAt: new Date(NOW.getTime() + 1).toISOString() } })).outcome).toBe("pass");
  });
  test("blocks on an unparseable expiry", () => {
    expect(r2NotExpired(ctx({ mandate: { expiresAt: "never" } })).outcome).toBe("block");
  });
});

describe("R3 request well-formed", () => {
  test("passes a clean request", () => expect(r3WellFormed(ctx()).outcome).toBe("pass"));
  test("passes when currency omitted or lowercase", () => {
    expect(r3WellFormed(ctx({ req: { currency: undefined } })).outcome).toBe("pass");
    expect(r3WellFormed(ctx({ req: { currency: "usdc" } })).outcome).toBe("pass");
  });
  test("passes exactly 6 decimals", () => expect(r3WellFormed(ctx({ req: { amount: 1.000001 } })).outcome).toBe("pass"));
  test.each([
    ["not an address", { recipient: "bob" }, "not a valid address"],
    ["short address", { recipient: "0x1234" }, "not a valid address"],
    ["non-hex address", { recipient: "0xZZ11111111111111111111111111111111111111" }, "not a valid address"],
    ["address with whitespace", { recipient: ` ${ADDR.apiVendor}` }, "not a valid address"],
    ["zero amount", { amount: 0 }, "greater than zero"],
    ["negative amount", { amount: -5 }, "greater than zero"],
    ["NaN amount", { amount: Number.NaN }, "greater than zero"],
    ["infinite amount", { amount: Number.POSITIVE_INFINITY }, "greater than zero"],
    ["7 decimals", { amount: 1.0000001 }, "more than 6 decimals"],
    ["wrong currency", { currency: "ETH" }, "Currency ETH is not allowed"],
  ] as const)("blocks %s", (_, req, reason) => {
    const c = r3WellFormed(ctx({ req }));
    expect(c.outcome).toBe("block");
    expect(c.reason).toContain(reason);
  });
});

describe("R4 allowlist", () => {
  test("passes an allowlisted recipient", () => expect(r4Allowlist(ctx()).outcome).toBe("pass"));
  test("passes regardless of address case", () => {
    expect(r4Allowlist(ctx({ req: { recipient: `0x${ADDR.apiVendor.slice(2).toUpperCase()}` } })).outcome).toBe("pass");
  });
  test("blocks an unknown recipient with a short specific reason", () => {
    const c = r4Allowlist(ctx({ req: { recipient: ADDR.attacker } }));
    expect(c.outcome).toBe("block");
    expect(c.reason).toBe("Recipient 0xabad…0012 is not on the allowlist");
  });
  test("blocks everything with an empty allowlist", () => {
    expect(r4Allowlist(ctx({ mandate: { allowlist: [] } })).outcome).toBe("block");
  });
});

describe("R5 per-transaction limit", () => {
  test("passes at the limit", () => expect(r5PerTx(ctx({ req: { amount: 10 } })).outcome).toBe("pass"));
  test("blocks just over the limit", () => {
    const c = r5PerTx(ctx({ req: { amount: 10.000001 } }));
    expect(c.outcome).toBe("block");
    expect(c.reason).toBe("10.000001 USDC exceeds the 10 USDC per-payment limit");
  });
});

describe("R6 monthly limit", () => {
  test("passes when spend plus amount reaches the limit exactly", () => {
    const c = r6Monthly(ctx({ monthSpend: 49, req: { amount: 1 } }));
    expect(c.outcome).toBe("pass");
    expect(c.reason).toBe("1 USDC of 50 USDC left this month");
  });
  test("avoids float drift at the boundary", () => {
    expect(r6Monthly(ctx({ monthSpend: 49.7, req: { amount: 0.3 } })).outcome).toBe("pass");
  });
  test("blocks when it would exceed the limit", () => {
    const c = r6Monthly(ctx({ monthSpend: 45.5, req: { amount: 5 } }));
    expect(c.outcome).toBe("block");
    expect(c.reason).toBe("5 USDC exceeds the 4.5 USDC left of the 50 USDC monthly limit");
  });
  test("blocks when already over the limit", () => {
    const c = r6Monthly(ctx({ monthSpend: 60, req: { amount: 1 } }));
    expect(c.outcome).toBe("block");
    expect(c.reason).toContain("0 USDC left");
  });
});

describe("R7 velocity", () => {
  const recent = (n: number, ago = 1) => Array.from({ length: n }, () => makePayment({ createdAt: minutesAgo(ago) }));
  test("passes below the limit", () => {
    const c = r7Velocity(ctx({ recent: recent(4) }));
    expect(c.outcome).toBe("pass");
    expect(c.reason).toBe("4 of 5 payments used in the last 10 min");
  });
  test("blocks at the limit", () => {
    const c = r7Velocity(ctx({ recent: recent(5) }));
    expect(c.outcome).toBe("block");
    expect(c.reason).toBe("Velocity limit hit: 5 payments in the last 10 min (max 5)");
  });
  test("ignores payments outside the window", () => {
    expect(r7Velocity(ctx({ recent: [...recent(4), ...recent(3, 11)] })).outcome).toBe("pass");
  });
});

describe("R8 approval threshold", () => {
  test("passes at the threshold", () => expect(r8Threshold(ctx({ req: { amount: 5 } })).outcome).toBe("pass"));
  test("escalates over the threshold", () => {
    const c = r8Threshold(ctx({ req: { amount: 5.01 } }));
    expect(c.outcome).toBe("escalate");
    expect(c.reason).toBe("5.01 USDC is over the 5 USDC auto-approve threshold");
  });
});

describe("runRules", () => {
  test("runs R1 to R8 in order", () => {
    expect(runRules(ctx()).map((c) => c.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
  });
  test("a clean request passes every rule", () => {
    expect(runRules(ctx()).every((c) => c.outcome === "pass")).toBe(true);
  });
  test("reports every failing rule, not just the first", () => {
    const checks = runRules(ctx({ mandate: { active: false }, req: { recipient: ADDR.attacker, amount: 20 } }));
    expect(checks.filter((c) => c.outcome === "block").map((c) => c.id)).toEqual(["R1", "R4", "R5"]);
    expect(checks.find((c) => c.id === "R8")!.outcome).toBe("escalate");
  });
  test("is pure: same input, same output, input untouched", () => {
    const c = ctx({ recent: [makePayment({ createdAt: minutesAgo(1) })] });
    const snapshot = structuredClone(c);
    expect(runRules(c)).toEqual(runRules(c));
    expect(c).toEqual(snapshot);
  });
});
