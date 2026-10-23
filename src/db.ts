import { Database } from "bun:sqlite";
import { fromMicros, toMicros } from "./money.ts";
import type { Address, Check, Mandate, Payment, PaymentFilter, PaymentStatus, Verdict } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  agent TEXT NOT NULL,
  purpose TEXT NOT NULL,
  currency TEXT NOT NULL,
  allowlist TEXT NOT NULL,
  per_tx_limit INTEGER NOT NULL,
  monthly_limit INTEGER NOT NULL,
  approval_threshold INTEGER NOT NULL,
  velocity_max INTEGER NOT NULL,
  velocity_minutes INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL REFERENCES mandates(id),
  recipient TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  memo TEXT NOT NULL,
  context TEXT,
  verdict TEXT NOT NULL,
  status TEXT NOT NULL,
  risk INTEGER NOT NULL,
  checks TEXT NOT NULL,
  reason TEXT,
  tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS payments_mandate_created ON payments(mandate_id, created_at);
CREATE INDEX IF NOT EXISTS payments_mandate_recipient ON payments(mandate_id, recipient);
`;

const SPENDING: PaymentStatus[] = ["settled", "pending_approval"];
const ATTEMPTED: PaymentStatus[] = ["settled", "pending_approval", "failed"];


interface MandateRow {
  id: string;
  name: string;
  owner: string;
  agent: string;
  purpose: string;
  currency: string;
  allowlist: string;
  per_tx_limit: number;
  monthly_limit: number;
  approval_threshold: number;
  velocity_max: number;
  velocity_minutes: number;
  expires_at: string;
  active: number;
  created_at: string;
}

interface PaymentRow {
  id: string;
  mandate_id: string;
  recipient: string;
  amount: number;
  currency: string;
  memo: string;
  context: string | null;
  verdict: string;
  status: string;
  risk: number;
  checks: string;
  reason: string | null;
  tx_hash: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

const mandateFromRow = (r: MandateRow): Mandate => ({
  id: r.id,
  name: r.name,
  owner: r.owner,
  agent: r.agent,
  purpose: r.purpose,
  currency: r.currency as "USDC",
  allowlist: JSON.parse(r.allowlist) as Address[],
  perTxLimit: fromMicros(r.per_tx_limit),
  monthlyLimit: fromMicros(r.monthly_limit),
  approvalThreshold: fromMicros(r.approval_threshold),
  velocity: { max: r.velocity_max, minutes: r.velocity_minutes },
  expiresAt: r.expires_at,
  active: r.active === 1,
  createdAt: r.created_at,
});

const mandateParams = (m: Mandate) => ({
  id: m.id,
  name: m.name,
  owner: m.owner,
  agent: m.agent,
  purpose: m.purpose,
  currency: m.currency,
  allowlist: JSON.stringify(m.allowlist),
  per_tx_limit: toMicros(m.perTxLimit),
  monthly_limit: toMicros(m.monthlyLimit),
  approval_threshold: toMicros(m.approvalThreshold),
  velocity_max: m.velocity.max,
  velocity_minutes: m.velocity.minutes,
  expires_at: m.expiresAt,
  active: m.active ? 1 : 0,
  created_at: m.createdAt,
});

const paymentFromRow = (r: PaymentRow): Payment => ({
  id: r.id,
  mandateId: r.mandate_id,
  recipient: r.recipient,
  amount: fromMicros(r.amount),
  currency: r.currency,
  memo: r.memo,
  context: r.context,
  verdict: r.verdict as Verdict,
  status: r.status as PaymentStatus,
  risk: r.risk,
  checks: JSON.parse(r.checks) as Check[],
  reason: r.reason,
  txHash: r.tx_hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  settledAt: r.settled_at,
});

const paymentParams = (p: Payment) => ({
  id: p.id,
  mandate_id: p.mandateId,
  recipient: p.recipient,
  amount: toMicros(p.amount),
  currency: p.currency,
  memo: p.memo,
  context: p.context,
  verdict: p.verdict,
  status: p.status,
  risk: p.risk,
  checks: JSON.stringify(p.checks),
  reason: p.reason,
  tx_hash: p.txHash,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
  settled_at: p.settledAt,
});

const inList = (values: string[]) => values.map((v) => `'${v}'`).join(",");

export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type PaymentPatch = Partial<Pick<Payment, "verdict" | "status" | "risk" | "checks" | "reason" | "txHash" | "updatedAt" | "settledAt">>;

export function openDb(path: string = process.env.DB_PATH ?? "asf.db") {
  const sql = new Database(path, { create: true, strict: true });
  sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  sql.exec(SCHEMA);

  const q = {
    upsertMandate: sql.query(`INSERT INTO mandates VALUES ($id,$name,$owner,$agent,$purpose,$currency,$allowlist,$per_tx_limit,$monthly_limit,$approval_threshold,$velocity_max,$velocity_minutes,$expires_at,$active,$created_at)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, owner=excluded.owner, agent=excluded.agent, purpose=excluded.purpose, currency=excluded.currency, allowlist=excluded.allowlist,
      per_tx_limit=excluded.per_tx_limit, monthly_limit=excluded.monthly_limit, approval_threshold=excluded.approval_threshold, velocity_max=excluded.velocity_max,
      velocity_minutes=excluded.velocity_minutes, expires_at=excluded.expires_at, active=excluded.active`),
    getMandate: sql.query<MandateRow, { id: string }>("SELECT * FROM mandates WHERE id = $id"),
    listMandates: sql.query<MandateRow, []>("SELECT * FROM mandates ORDER BY created_at, id"),
    insertPayment: sql.query(`INSERT INTO payments VALUES ($id,$mandate_id,$recipient,$amount,$currency,$memo,$context,$verdict,$status,$risk,$checks,$reason,$tx_hash,$created_at,$updated_at,$settled_at)`),
    updatePayment: sql.query(`UPDATE payments SET verdict=$verdict, status=$status, risk=$risk, checks=$checks, reason=$reason, tx_hash=$tx_hash, updated_at=$updated_at, settled_at=$settled_at WHERE id=$id`),
    getPayment: sql.query<PaymentRow, { id: string }>("SELECT * FROM payments WHERE id = $id"),
    monthSpend: sql.query<{ total: number | null }, { mandate_id: string; since: string }>(
      `SELECT SUM(amount) AS total FROM payments WHERE mandate_id = $mandate_id AND created_at >= $since AND status IN (${inList(SPENDING)})`,
    ),
    recent: sql.query<PaymentRow, { mandate_id: string; since: string }>(
      `SELECT * FROM payments WHERE mandate_id = $mandate_id AND created_at >= $since AND status IN (${inList(ATTEMPTED)}) ORDER BY created_at DESC, rowid DESC`,
    ),
    history: sql.query<PaymentRow, { mandate_id: string; recipient: string }>(
      `SELECT * FROM payments WHERE mandate_id = $mandate_id AND lower(recipient) = lower($recipient) AND status = 'settled' ORDER BY created_at DESC, rowid DESC`,
    ),
  };

  return {
    sql,
    close: () => sql.close(),

    upsertMandate(m: Mandate): Mandate {
      q.upsertMandate.run(mandateParams(m));
      return this.getMandate(m.id)!;
    },
    getMandate(id: string): Mandate | null {
      const row = q.getMandate.get({ id });
      return row ? mandateFromRow(row) : null;
    },
    listMandates(): Mandate[] {
      return q.listMandates.all().map(mandateFromRow);
    },

    insertPayment(p: Payment): Payment {
      q.insertPayment.run(paymentParams(p));
      return this.getPayment(p.id)!;
    },
    getPayment(id: string): Payment | null {
      const row = q.getPayment.get({ id });
      return row ? paymentFromRow(row) : null;
    },
    updatePayment(id: string, patch: PaymentPatch): Payment | null {
      const current = this.getPayment(id);
      if (!current) return null;
      q.updatePayment.run(paymentParams({ ...current, ...patch }));
      return this.getPayment(id);
    },
    listPayments(filter: PaymentFilter = {}): Payment[] {
      const where: string[] = [];
      const params: Record<string, string | number> = {};
      if (filter.mandateId !== undefined) {
        where.push("mandate_id = $mandate_id");
        params.mandate_id = filter.mandateId;
      }
      if (filter.status !== undefined) {
        where.push("status = $status");
        params.status = filter.status;
      }
      let text = "SELECT * FROM payments";
      if (where.length) text += ` WHERE ${where.join(" AND ")}`;
      text += " ORDER BY created_at DESC, rowid DESC";
      if (filter.limit !== undefined) {
        text += " LIMIT $limit";
        params.limit = Math.max(0, Math.floor(filter.limit));
      }
      return sql.query<PaymentRow, Record<string, string | number>>(text).all(params).map(paymentFromRow);
    },

    monthSpend(mandateId: string, now: Date = new Date()): number {
      const row = q.monthSpend.get({ mandate_id: mandateId, since: monthStart(now) });
      return fromMicros(row?.total ?? 0);
    },
    recentPayments(mandateId: string, minutes: number, now: Date = new Date()): Payment[] {
      const since = new Date(now.getTime() - minutes * 60_000).toISOString();
      return q.recent.all({ mandate_id: mandateId, since }).map(paymentFromRow);
    },
    historyTo(mandateId: string, recipient: string): Payment[] {
      return q.history.all({ mandate_id: mandateId, recipient }).map(paymentFromRow);
    },
  };
}

export type Db = ReturnType<typeof openDb>;
