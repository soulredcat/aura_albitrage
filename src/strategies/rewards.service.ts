import { d, Decimal, min, max } from '../domain/money.js';

export function positionScore(distance: Decimal, maxDistance: Decimal, multiplier: Decimal) {
  if (maxDistance.lte(0) || distance.lt(0)) throw new Error('invalid score parameters');
  if (distance.gte(maxDistance)) return d('0');
  return maxDistance.minus(distance).div(maxDistance).pow(2).mul(multiplier);
}

export function twoSidedScore(one: Decimal, two: Decimal, midpoint: Decimal) {
  if (midpoint.lt('0.10') || midpoint.gt('0.90')) return min(one, two);
  return max(min(one, two), max(one.div(3), two.div(3)));
}
