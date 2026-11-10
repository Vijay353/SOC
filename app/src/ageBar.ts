/**
 * CH-10: geometry for an evidence-age bar drawn to true scale.
 * The track is as long as the larger of the age and the limit, so neither value is clipped.
 * When the age is over the limit the bar says so in words; color is never the only signal.
 */
export interface AgeBar {
  fillPct: number;
  limitPct: number;
  over: boolean;
  text: string;
}

export function formatMinutes(min: number): string {
  if (min < 90) return `${Math.round(min)} min`;
  return `${(min / 60).toFixed(1)} h`;
}

export function ageBar(ageMinutes: number, limitMinutes: number): AgeBar {
  const age = Math.max(0, ageMinutes);
  const track = Math.max(age, limitMinutes);
  const over = age > limitMinutes;
  return {
    fillPct: track === 0 ? 0 : Math.round((age / track) * 1000) / 10,
    limitPct: track === 0 ? 100 : Math.round((limitMinutes / track) * 1000) / 10,
    over,
    text: over
      ? `${formatMinutes(age)} old, over the ${formatMinutes(limitMinutes)} limit by ${formatMinutes(age - limitMinutes)}`
      : `${formatMinutes(age)} old, within the ${formatMinutes(limitMinutes)} limit`,
  };
}
