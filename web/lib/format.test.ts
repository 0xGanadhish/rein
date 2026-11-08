import { describe, expect, it } from 'vitest';
import { units } from './format';

describe('format', () => {
  it('units_shows_negative_amounts', () => {
    expect(units('-1500000', 6)).toBe('-1.50');
    expect(units('-500000', 6)).toBe('-0.50');
  });
});
