export const now = (): number => Date.now();

export const recencyScore = (timestamp: number | null, nowMs: number): number => {
  if (!timestamp) {
    return 0;
  }

  const ageMs = Math.max(0, nowMs - timestamp);
  const oneDay = 24 * 60 * 60 * 1000;
  return 1 / (1 + ageMs / oneDay);
};

export const decayFactor = (elapsedMs: number, halfLifeHours: number): number => {
  const halfLifeMs = halfLifeHours * 60 * 60 * 1000;
  if (halfLifeMs <= 0) {
    return 1;
  }

  return Math.pow(0.5, elapsedMs / halfLifeMs);
};
