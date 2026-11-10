import { useState } from 'react';
import { track } from '../analytics';
import { getDemoUser } from '../api';

const STATUS_WORDS: Record<string, string> = {
  complete: 'Every expected record was found and the audit log check passed.',
  partial: 'Some evidence is missing. The reasons are listed below and inside the file.',
  unverifiable: 'The audit log check failed. Do not rely on this file.',
};

/** CH-18: downloads one request's audit evidence package exactly as the server produced it. Changes nothing. */
export function EvidenceExport({ requestId }: { requestId: string }) {
  const [result, setResult] = useState<{ status: string; reasons: string[]; digest: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    track('audit_export_clicked');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/requests/${encodeURIComponent(requestId)}/evidence-package`, { headers: { 'x-demo-user': getDemoUser() } });
      const text = await res.text();
      const body = JSON.parse(text) as { evidenceStatus?: string; statusReasons?: string[]; digest?: { value: string }; error?: { code: string; message: string } };
      if (!res.ok) throw new Error(body.error ? `${body.error.message} (code: ${body.error.code})` : `Export failed (${res.status})`);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-evidence-${requestId.replace(/[^A-Za-z0-9-]/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setResult({ status: body.evidenceStatus ?? 'unverifiable', reasons: body.statusReasons ?? [], digest: body.digest?.value ?? '' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="export-h" data-testid="evidence-export">
      <h2 id="export-h" style={{ marginTop: 0 }}>
        Audit evidence package
      </h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        One JSON file with this request, its decisions, the approval packet, the run traces and its audit rows. It has a SHA-256 checksum, not a signature. Exporting changes nothing.
      </p>
      <button className="btn btn-sm" onClick={() => void run()} disabled={busy} data-testid="export-evidence">
        {busy ? 'Preparing…' : 'Export audit evidence package'}
      </button>
      {error && (
        <p role="alert" data-testid="export-error">
          {error}
        </p>
      )}
      {result && (
        <div role="status" data-testid="export-result">
          <p>
            Evidence status: <strong data-testid="export-status">{result.status}</strong>. {STATUS_WORDS[result.status] ?? ''}
          </p>
          {result.reasons.length > 0 && (
            <ul>
              {result.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <p className="small muted mono">Checksum (SHA-256): {result.digest}</p>
        </div>
      )}
    </section>
  );
}
