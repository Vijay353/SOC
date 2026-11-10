import { CHECK_STATUS_WORDS, checkSummaryText, refText } from '../evidenceChecks';
import type { EvidenceCheck } from '../types';

const TONE: Record<EvidenceCheck['status'], string> = { PASS: 'badge-ok', WARN: 'badge-warn', FAIL: 'badge-danger', NOT_EVALUATED: 'badge' };

/** CH-19: read-only view of the checks the server recorded when it decided. It cannot approve or stage anything. */
export function EvidenceChecks({ checks, evidenceHashes }: { checks: EvidenceCheck[] | undefined; evidenceHashes: Record<string, string> }) {
  return (
    <details className="panel evidence-checks" data-testid="evidence-checks">
      <summary>
        <strong>Evidence checks:</strong> <span data-testid="evidence-checks-summary">{checkSummaryText(checks)}</span>
      </summary>
      {checks && (
        <>
          <div className="table-wrap">
            <table className="data">
              <caption className="small muted" style={{ textAlign: 'left' }}>
                Rule results recorded by the server when it made this decision. They are not model reasoning.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Result</th>
                  <th scope="col">Why</th>
                  <th scope="col">What it read</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.checkId} data-testid={`check-${c.checkId}`}>
                    <td>{c.label}</td>
                    <td>
                      <span className={`badge ${TONE[c.status]}`}>{CHECK_STATUS_WORDS[c.status]}</span>
                      {c.blocksAutoAction && <div className="small muted">Keeps this off the standard path</div>}
                    </td>
                    <td>{c.detail}</td>
                    <td className="small">
                      {c.evidenceRefs.map((r) => {
                        const key = r.startsWith('evidence:') ? r.slice(9) : null;
                        const hash = key ? evidenceHashes[key] : undefined;
                        return (
                          <div key={r}>
                            {refText(r)}
                            {key && (hash ? <span className="mono muted"> ({hash.slice(0, 10)}…)</span> : <span className="muted"> (not available)</span>)}
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">This list is read-only. Only the server can stage an approval packet, and it re-checks evidence when it does.</p>
        </>
      )}
    </details>
  );
}
