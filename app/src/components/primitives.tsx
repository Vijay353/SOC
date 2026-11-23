/** Product-clarity CH-3: small shared presentation pieces used by the new UI. Display only, no data access. */

/** A count shown next to a label. Renders nothing for zero so "0 waiting" never adds noise. */
export function CountBadge({ count, label, testId }: { count: number; label: string; testId?: string }) {
  if (count <= 0) return null;
  return (
    <span className="count-badge" data-testid={testId}>
      {count}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

/** One number with its label. The value must come from persisted state; this component never computes it. */
export function MetricTile({ label, value, note, tone, testId }: { label: string; value: string | number; note?: string; tone?: 'ok' | 'warn' | 'danger'; testId?: string }) {
  return (
    <div className={`metric-tile ${tone ? `metric-${tone}` : ''}`} data-testid={testId}>
      <span className="metric-value">{typeof value === 'number' ? value.toLocaleString('en-US') : value}</span>
      <span className="metric-label">{label}</span>
      {note && <span className="metric-note">{note}</span>}
    </div>
  );
}
