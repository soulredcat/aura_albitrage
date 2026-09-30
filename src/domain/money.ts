import { Decimal } from 'decimal.js';

// Internal normalized decimal amounts only. Native base units must be mapped
// from verified protocol configuration before a live adapter can be enabled.
Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
export const d = (value: string | Decimal) => new Decimal(value);
export const min = (...values: Decimal[]) => Decimal.min(...values);
export const max = (...values: Decimal[]) => Decimal.max(...values);
export { Decimal };
