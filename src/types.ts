export type Address = `0x${string}`;

export type Verdict = "approved" | "needs_approval" | "blocked";

export type PaymentStatus = "pending_approval" | "settled" | "blocked" | "rejected" | "failed";

export type CheckOutcome = "pass" | "escalate" | "block";

export type CheckId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "INTENT";

export interface Check {
  id: CheckId;
  name: string;
  outcome: CheckOutcome;
  reason: string;
}

export interface Mandate {
  id: string;
  name: string;
  owner: string;
  agent: string;
  purpose: string;
  currency: "USDC";
  allowlist: Address[];
  perTxLimit: number;
  monthlyLimit: number;
  approvalThreshold: number;
  velocity: { max: number; minutes: number };
  expiresAt: string;
  active: boolean;
  createdAt: string;
}

export type MandateInput = Omit<Mandate, "id" | "createdAt"> & { id?: string };

export interface PaymentRequest {
  recipient: string;
  amount: number;
  currency?: string;
  memo: string;
  context?: string;
}

export interface Payment {
  id: string;
  mandateId: string;
  recipient: string;
  amount: number;
  currency: string;
  memo: string;
  context: string | null;
  verdict: Verdict;
  status: PaymentStatus;
  risk: number;
  checks: Check[];
  reason: string | null;
  txHash: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
}

export interface PaymentFilter {
  mandateId?: string;
  status?: PaymentStatus;
  limit?: number;
}

export interface Spend {
  mandateId: string;
  month: number;
  limit: number;
  remaining: number;
}

export interface Core {
  listMandates(): Promise<Mandate[]>;
  getMandate(id: string): Promise<Mandate | null>;
  createMandate(input: MandateInput): Promise<Mandate>;
  updateMandate(id: string, patch: Partial<MandateInput>): Promise<Mandate>;
  requestPayment(mandateId: string, req: PaymentRequest): Promise<Payment>;
  getPayment(id: string): Promise<Payment | null>;
  listPayments(filter?: PaymentFilter): Promise<Payment[]>;
  approvePayment(id: string): Promise<Payment>;
  rejectPayment(id: string, reason?: string): Promise<Payment>;
  getSpend(mandateId: string): Promise<Spend>;
}

export type CoreErrorCode = "not_found" | "invalid_state" | "invalid_input" | "not_implemented";

export class CoreError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}
