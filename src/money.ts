export const toMicros = (usdc: number) => Math.round(usdc * 1_000_000);

export const fromMicros = (micros: number) => micros / 1_000_000;

export const hasValidPrecision = (usdc: number) => Math.abs(usdc * 1_000_000 - toMicros(usdc)) < 1e-6;
