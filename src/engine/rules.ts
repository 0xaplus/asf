import { fromMicros, hasValidPrecision, toMicros } from "../money.ts";
import type { Check, CheckId, Mandate, Payment, PaymentRequest } from "../types.ts";
import { shortAddr, usdc } from "./format.ts";

export interface RuleCtx {
  mandate: Mandate;
  req: PaymentRequest;
  monthSpend: number;
  recent: Payment[];
  history: Payment[];
  now: Date;
}

export type Rule = (ctx: RuleCtx) => Check;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const pass = (id: CheckId, name: string, reason: string): Check => ({ id, name, outcome: "pass", reason });
const block = (id: CheckId, name: string, reason: string): Check => ({ id, name, outcome: "block", reason });
const escalate = (id: CheckId, name: string, reason: string): Check => ({ id, name, outcome: "escalate", reason });

export const r1Active: Rule = ({ mandate }) =>
  mandate.active ? pass("R1", "mandate_active", "Mandate is active") : block("R1", "mandate_active", "Mandate is paused");

export const r2NotExpired: Rule = ({ mandate, now }) => {
  const expires = Date.parse(mandate.expiresAt);
  if (Number.isNaN(expires)) return block("R2", "mandate_expiry", "Mandate expiry date is invalid");
  return now.getTime() < expires
    ? pass("R2", "mandate_expiry", `Mandate valid until ${mandate.expiresAt.slice(0, 10)}`)
    : block("R2", "mandate_expiry", `Mandate expired on ${mandate.expiresAt.slice(0, 10)}`);
};

export const r3WellFormed: Rule = ({ mandate, req }) => {
  const name = "request_valid";
  if (!ADDRESS.test(req.recipient)) return block("R3", name, `Recipient "${shortAddr(req.recipient)}" is not a valid address`);
  if (!Number.isFinite(req.amount) || req.amount <= 0) return block("R3", name, `Amount ${req.amount} must be greater than zero`);
  if (!hasValidPrecision(req.amount)) return block("R3", name, `Amount ${req.amount} has more than 6 decimals`);
  const currency = req.currency ?? mandate.currency;
  if (currency.toUpperCase() !== mandate.currency) return block("R3", name, `Currency ${currency} is not allowed, only ${mandate.currency}`);
  return pass("R3", name, "Request is well-formed");
};

export const r4Allowlist: Rule = ({ mandate, req }) => {
  const recipient = req.recipient.toLowerCase();
  return mandate.allowlist.some((a) => a.toLowerCase() === recipient)
    ? pass("R4", "allowlist", `Recipient ${shortAddr(req.recipient)} is on the allowlist`)
    : block("R4", "allowlist", `Recipient ${shortAddr(req.recipient)} is not on the allowlist`);
};

export const r5PerTx: Rule = ({ mandate, req }) =>
  toMicros(req.amount) <= toMicros(mandate.perTxLimit)
    ? pass("R5", "per_tx_limit", `${usdc(req.amount)} is within the ${usdc(mandate.perTxLimit)} per-payment limit`)
    : block("R5", "per_tx_limit", `${usdc(req.amount)} exceeds the ${usdc(mandate.perTxLimit)} per-payment limit`);

export const r6Monthly: Rule = ({ mandate, req, monthSpend }) => {
  const after = toMicros(monthSpend) + toMicros(req.amount);
  const remaining = Math.max(0, toMicros(mandate.monthlyLimit) - toMicros(monthSpend));
  return after <= toMicros(mandate.monthlyLimit)
    ? pass("R6", "monthly_limit", `${usdc(fromMicros(remaining))} of ${usdc(mandate.monthlyLimit)} left this month`)
    : block("R6", "monthly_limit", `${usdc(req.amount)} exceeds the ${usdc(fromMicros(remaining))} left of the ${usdc(mandate.monthlyLimit)} monthly limit`);
};

export const r7Velocity: Rule = ({ mandate, recent, now }) => {
  const since = now.getTime() - mandate.velocity.minutes * 60_000;
  const count = recent.filter((p) => Date.parse(p.createdAt) >= since).length;
  const window = `${mandate.velocity.minutes} min`;
  return count < mandate.velocity.max
    ? pass("R7", "velocity", `${count} of ${mandate.velocity.max} payments used in the last ${window}`)
    : block("R7", "velocity", `Velocity limit hit: ${count} payments in the last ${window} (max ${mandate.velocity.max})`);
};

export const r8Threshold: Rule = ({ mandate, req }) =>
  toMicros(req.amount) <= toMicros(mandate.approvalThreshold)
    ? pass("R8", "approval_threshold", `${usdc(req.amount)} is within the ${usdc(mandate.approvalThreshold)} auto-approve threshold`)
    : escalate("R8", "approval_threshold", `${usdc(req.amount)} is over the ${usdc(mandate.approvalThreshold)} auto-approve threshold`);

export const RULES: Rule[] = [r1Active, r2NotExpired, r3WellFormed, r4Allowlist, r5PerTx, r6Monthly, r7Velocity, r8Threshold];

export const runRules = (ctx: RuleCtx): Check[] => RULES.map((rule) => rule(ctx));
