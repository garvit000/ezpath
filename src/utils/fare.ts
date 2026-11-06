export type FareStatus = 'complete' | 'partial';

/** Never show a partial total as if it were the full price of the journey. */
export function fareLabel(fareINR: number, status: FareStatus = 'complete'): string {
  if (status === 'complete') return `₹${fareINR}`;
  return fareINR > 0 ? `₹${fareINR} + other fares` : 'Fare not published';
}
