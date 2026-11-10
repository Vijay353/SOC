import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, upload } from '../api';
import { codeWords, ErrorBanner, fmtDateTime } from '../ui';

const ENTITIES = ['Incidents', 'Devices', 'Alerts', 'DeviceActivity', 'Users', 'ConfigItems', 'Dependencies', 'ChangeFreezes', 'Documents'] as const;

interface Issue {
  sheet: string | null;
  row: number | null;
  column: string | null;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}
interface SheetPreview {
  added: number;
  updated: number;
  unchanged: number;
  rejected: number;
  removed: number;
  rows: Array<{ rowNumber: number; key: string; outcome: string; changes?: string[] }>;
}
interface Preview {
  importId: string;
  fileName: string;
  fileSha256: string;
  mode: 'merge' | 'replace';
  canCommit: boolean;
  sheets: Record<string, SheetPreview>;
  issues: Issue[];
  warnings: string[];
  sideEffects: string[];
}
interface HistoryItem {
  importId: string;
  fileName: string;
  mode: string;
  status: string;
  actor: string;
  summary: Record<string, unknown>;
  restorable: boolean;
  createdAt: string;
  committedAt: string | null;
}

/** Secondary surface: edit simulator data through Excel/CSV. Interchange only, not an integration. */
export function DataStudioPage({ onChanged }: { onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [entity, setEntity] = useState<string>('ConfigItems');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [committed, setCommitted] = useState<Record<string, unknown> | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [armedRestore, setArmedRestore] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [browse, setBrowse] = useState<string>('ConfigItems');
  const [q, setQ] = useState('');
  const [records, setRecords] = useState<{ total: number; value: Array<Record<string, unknown>> } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const isCsv = file?.name.toLowerCase().endsWith('.csv') ?? false;

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api<{ value: HistoryItem[] }>('GET', '/data/imports')).value);
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    }
  }, []);
  const loadRecords = useCallback(async () => {
    try {
      setRecords(await api('GET', `/data/records/${browse}?q=${encodeURIComponent(q)}`));
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    }
  }, [browse, q]);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);
  useEffect(() => {
    const t = setTimeout(loadRecords, 200);
    return () => clearTimeout(t);
  }, [loadRecords]);

  const doPreview = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setCommitted(null);
    setConfirmed(false);
    try {
      setPreview(await upload<Preview>('/data/import/preview', file, { mode: isCsv ? 'merge' : mode, ...(isCsv ? { entity } : {}) }));
      await loadHistory();
    } catch (e) {
      setPreview(null);
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const doCommit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: string; summary: Record<string, unknown> }>('POST', `/data/import/${preview.importId}/commit`, { confirm: true });
      setCommitted(r);
      setPreview(null);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      await Promise.all([loadHistory(), loadRecords()]);
      onChanged();
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (id: string) => {
    if (armedRestore !== id) {
      setArmedRestore(id);
      return;
    }
    setArmedRestore(null);
    setError(null);
    try {
      const r = await api<Record<string, unknown>>('POST', `/data/imports/${id}/restore`, { confirm: true });
      setCommitted({ status: 'RESTORED', summary: r });
      await Promise.all([loadHistory(), loadRecords()]);
      onChanged();
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    }
  };

  const errors = preview?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = preview?.issues.filter((i) => i.severity === 'warning') ?? [];
  const columns = records?.value[0] ? Object.keys(records.value[0]).slice(0, 12) : [];

  return (
    <div>
      <section className="panel">
        <h2>Data Studio: simulator data in Excel</h2>
        <p className="lead">
          Download the sample workbook, edit records in Excel, and import them into Mock Microsoft Security and Mock ITSM/CMDB. Every import is validated, previewed and confirmed before anything changes. This is data interchange for the
          simulators. It is not a real integration and not a system of record.
        </p>
        <div className="row">
          <a className="btn" href="/api/data/template.xlsx" download>
            Download sample workbook (.xlsx)
          </a>
          <a className="btn" href="/api/data/export.xlsx" download>
            Export current state (.xlsx)
          </a>
          <button
            className="btn"
            onClick={async () => {
              await api('POST', '/lab/reset');
              setPreview(null);
              setCommitted({ status: 'RESET', summary: { note: 'Simulators and Gate restored to the sample dataset' } });
              await Promise.all([loadHistory(), loadRecords()]);
              onChanged();
            }}
          >
            Reset to sample dataset
          </button>
        </div>
      </section>

      <ErrorBanner error={error} />

      <section className="panel" aria-labelledby="imp">
        <h2 id="imp">Import</h2>
        <p className="lead">
          <strong>Merge</strong> upserts rows and never deletes (keep the exported <code>revision</code> to update Incidents, Devices and ConfigItems). <strong>Replace</strong> loads a complete workbook and clears workflow state. CSV imports one
          entity in merge mode.
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            File (.xlsx or .csv, max 5 MB)
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.csv"
              data-testid="import-file"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          </label>
          {!isCsv && (
            <label className="field">
              Mode
              <select value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}>
                <option value="merge">Merge (upsert)</option>
                <option value="replace">Replace entire dataset</option>
              </select>
            </label>
          )}
          {isCsv && (
            <label className="field">
              CSV entity
              <select value={entity} onChange={(e) => setEntity(e.target.value)}>
                {ENTITIES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          )}
          <button className="btn" onClick={doPreview} disabled={!file || busy} data-testid="preview-import">
            {busy ? 'Validating…' : 'Validate & preview'}
          </button>
        </div>

        {preview && (
          <div className="stack" style={{ marginTop: 16 }} data-testid="import-preview">
            <div className={`banner ${preview.canCommit ? 'banner-info' : 'banner-error'}`} role="status">
              <strong>{preview.fileName}</strong> · {preview.mode} · {errors.length} error(s), {warnings.length + preview.warnings.length} warning(s) ·{' '}
              {preview.canCommit ? 'ready to commit after confirmation' : errors.length ? 'fix the errors below and upload again. Nothing was changed' : 'no changes to apply'}
            </div>
            <div className="table-wrap" style={{ maxHeight: 'none' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Sheet</th>
                    <th>Added</th>
                    <th>Updated</th>
                    <th>Unchanged</th>
                    <th>Rejected</th>
                    {preview.mode === 'replace' && <th>Removed</th>}
                    <th>Changed rows</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(preview.sheets).map(([sheet, s]) => (
                    <tr key={sheet}>
                      <td>{sheet}</td>
                      <td>{s.added}</td>
                      <td>{s.updated}</td>
                      <td>{s.unchanged}</td>
                      <td className={s.rejected ? 'val-danger' : ''}>{s.rejected}</td>
                      {preview.mode === 'replace' && <td>{s.removed}</td>}
                      <td className="small">
                        {s.rows
                          .filter((r) => r.outcome !== 'UNCHANGED')
                          .slice(0, 6)
                          .map((r) => `${r.key} (${r.outcome.toLowerCase()}${r.changes?.length ? `: ${r.changes.join(', ')}` : ''})`)
                          .join('; ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.issues.length > 0 && (
              <div className="table-wrap" data-testid="import-issues">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Sheet</th>
                      <th>Row</th>
                      <th>Column</th>
                      <th>Code</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.issues.slice(0, 150).map((i, k) => (
                      <tr key={k}>
                        <td className={i.severity === 'error' ? 'val-danger' : 'val-warn'}>{i.severity}</td>
                        <td>{i.sheet ?? 'n/a'}</td>
                        <td>{i.row ?? 'n/a'}</td>
                        <td>{i.column ?? 'n/a'}</td>
                        <td>
                          <code>{i.code}</code>
                        </td>
                        <td>{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.warnings.length > 0 && (
              <div className="banner banner-warn">
                <strong>How the Gate will read this data:</strong>
                <ul style={{ margin: '6px 0 0' }}>
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.canCommit && (
              <div className="row">
                <label className="row small">
                  <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="confirm-import" />
                  {preview.sideEffects.join(' ')}
                </label>
                <button className="btn btn-ok" onClick={doCommit} disabled={!confirmed || busy} data-testid="commit-import">
                  Commit import
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    await api('POST', `/data/import/${preview.importId}/discard`);
                    setPreview(null);
                    await loadHistory();
                  }}
                >
                  Discard
                </button>
              </div>
            )}
          </div>
        )}
        {committed && (
          <div className="banner banner-info" role="status" style={{ marginTop: 14 }} data-testid="import-committed">
            <strong>{String(committed.status)}</strong>
            {committed.summary && typeof committed.summary === 'object' && 'verifiedRows' in committed.summary ? ` · ${String((committed.summary as Record<string, unknown>).verifiedRows)} row(s) re-read from the simulators and verified` : ''}
          </div>
        )}
      </section>

      <div className="grid-2">
        <section className="panel" aria-labelledby="hist">
          <h2 id="hist">Import history</h2>
          <p className="lead">Each commit keeps a pre-commit snapshot. Restore returns the simulators to that snapshot and clears workflow state.</p>
          {history.length === 0 && <p className="muted">No imports yet. Download the sample workbook, edit it, and import it above.</p>}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>File</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.importId}>
                    <td className="mono small">{fmtDateTime(h.committedAt ?? h.createdAt)}</td>
                    <td>
                      {h.fileName}
                      <div className="small muted">
                        {h.importId} · {h.actor}
                      </div>
                    </td>
                    <td>{codeWords(h.mode)}</td>
                    <td>{codeWords(h.status)}</td>
                    <td>
                      {h.restorable && (
                        <button className="btn btn-sm" onClick={() => doRestore(h.importId)}>
                          {armedRestore === h.importId ? 'Confirm restore' : 'Restore before'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel" aria-labelledby="rec">
          <h2 id="rec">Record browser</h2>
          <p className="lead">Live simulator records. Watch them change as you import or as the workflow stages and decides approvals.</p>
          <div className="row" style={{ marginBottom: 10 }}>
            <select value={browse} onChange={(e) => setBrowse(e.target.value)} aria-label="Entity">
              {[...ENTITIES, 'ApprovalPackets'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search records" className="field" style={{ border: '1px solid var(--border-strong)', borderRadius: 6, padding: '6px 9px' }} />
            {browse !== 'ApprovalPackets' && (
              <a className="btn btn-sm" href={`/api/data/export/${browse}.csv`} download>
                CSV
              </a>
            )}
            <span className="small muted">{records ? `${records.value.length} of ${records.total}` : ''}</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records && records.value.length === 0 && (
                  <tr>
                    <td data-testid="records-empty">
                      {records.total === 0 ? (
                        `No ${browse} records yet.`
                      ) : (
                        <>
                          No records match "{q}".{' '}
                          <button className="btn btn-sm" onClick={() => setQ('')}>
                            Clear search
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )}
                {records?.value.map((r, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c} className="small">
                        {formatCell(r[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
