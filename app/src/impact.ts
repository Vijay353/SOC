/**
 * CH-7: read-only projection of what approval would allow. Pure and deterministic: it only restates facts the
 * Gate already recorded in the evaluation. It never estimates anything the data does not contain.
 */
export interface ImpactFacts {
  host: string;
  businessService: string | null;
  activeSessionCount: number | null;
  sessionsObservedAt: string | null;
  activeCriticalDependencies: number | null;
  changeFreeze: { active: boolean; freezeId?: string; endsAt?: string } | null;
  evaluatedAt: string;
}

export interface ImpactLine {
  label: string;
  value: string;
  known: boolean;
}

const fmt = (n: number) => n.toLocaleString('en-US');
const at = (iso: string) => `${iso.slice(11, 16)} UTC`;

export function projectImpact(f: ImpactFacts): { lines: ImpactLine[]; caveat: string } {
  const lines: ImpactLine[] = [];
  lines.push(
    f.activeSessionCount === null
      ? { label: 'Network sessions that full isolation would cut', value: 'Unknown: no current activity summary', known: false }
      : { label: 'Network sessions that full isolation would cut', value: `${fmt(f.activeSessionCount)} active at ${f.sessionsObservedAt ? at(f.sessionsObservedAt) : 'an unknown time'}`, known: true },
  );
  lines.push(
    f.activeCriticalDependencies === null
      ? { label: 'Critical workflows that depend on the device', value: 'Unknown: CMDB evidence missing', known: false }
      : { label: 'Critical workflows that depend on the device', value: fmt(f.activeCriticalDependencies), known: true },
  );
  if (f.businessService) lines.push({ label: 'Business service', value: f.businessService, known: true });
  lines.push(
    f.changeFreeze === null
      ? { label: 'Change freeze', value: 'Unknown', known: false }
      : f.changeFreeze.active
        ? { label: 'Change freeze', value: `Active (${f.changeFreeze.freezeId}) until ${f.changeFreeze.endsAt?.slice(0, 10)} ${f.changeFreeze.endsAt ? at(f.changeFreeze.endsAt) : ''}`.trim(), known: true }
        : { label: 'Change freeze', value: 'None active', known: true },
  );
  return {
    lines,
    caveat: `Projection only, from evidence read at ${at(f.evaluatedAt)}. No records changed. Approval lets the analyst run the isolation of ${f.host} in Defender; nothing on this screen isolates anything.`,
  };
}
