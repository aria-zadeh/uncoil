import { describe, expect, it } from 'vitest';

import { calibrationLine } from '@/utils/calibration';

describe('calibrationLine', () => {
  it('reads "about on time" within 10% of the estimate', () => {
    expect(calibrationLine(1.0)).toBe('Your estimates tend to run about on time');
    expect(calibrationLine(1.05)).toBe('Your estimates tend to run about on time');
    expect(calibrationLine(0.95)).toBe('Your estimates tend to run about on time');
  });

  it('reads "long" and the percent over when work takes longer than estimated', () => {
    expect(calibrationLine(1.4)).toBe('Your estimates tend to run long, by about 40%');
  });

  it('reads "short" and the percent under when work finishes faster than estimated', () => {
    expect(calibrationLine(0.7)).toBe('Your estimates tend to run short, by about 30%');
  });

  it('rounds to the nearest percent', () => {
    expect(calibrationLine(1.333)).toBe('Your estimates tend to run long, by about 33%');
  });

  it('treats exactly 10% off as long or short rather than "on time"', () => {
    expect(calibrationLine(1.1)).toBe('Your estimates tend to run long, by about 10%');
    expect(calibrationLine(0.9)).toBe('Your estimates tend to run short, by about 10%');
  });
});
