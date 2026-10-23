export const shortAddr = (a: string) => (a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export const usdc = (n: number) => `${Number(n.toFixed(6))} USDC`;
