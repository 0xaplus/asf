# asf

Agent spend firewall: AI agents request USDC payments against a mandate; a policy engine and an LLM intent check decide whether each payment settles, waits for human approval, or is blocked.

## Layout

- `src/types.ts` — shared contract (`Core` interface). Change only on `master`, agreed by both parts.
- `src/fixtures.ts` — `DEMO_MANDATE` and sample requests.
- Part A (`part-a`): `src/core.ts`, `src/db.ts`, `src/seed.ts`, `src/engine/`, `src/settle/`.
- Part B (`part-b`): `src/index.ts`, `src/api.ts`, `src/mcp/`, `src/core.fake.ts`, `public/`, `demo/`, `bench/`.

## Policy rules

| ID | Rule | Outcome on failure |
|----|------|--------------------|
| R1 | Mandate is active | block |
| R2 | Mandate has not expired | block |
| R3 | Request is well-formed: valid address, positive amount with at most 6 decimals, currency USDC | block |
| R4 | Recipient is on the allowlist | block |
| R5 | Amount is within the per-transaction limit | block |
| R6 | Month-to-date spend plus amount is within the monthly limit | block |
| R7 | Payments in the velocity window are below the limit | block |
| R8 | Amount is at or below the approval threshold | escalate |

The LLM intent check runs only when no rule blocks, and can only make the verdict stricter.

## Commands

```sh
bun install
bun test
bun run seed
```
