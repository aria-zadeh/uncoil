// takes the ratio as a bare number because utils can't import services

// this close to 1 reads as "about on time"
const ON_TIME_BAND = 0.1;

// ratio is actual over estimated minutes, the median of the student's own sessions
export function calibrationLine(ratio: number): string {
  const percent = Math.round(Math.abs(ratio - 1) * 100);
  if (percent < ON_TIME_BAND * 100) return 'Your estimates tend to run about on time';
  return `Your estimates tend to run ${ratio > 1 ? 'long' : 'short'}, by about ${percent}%`;
}
