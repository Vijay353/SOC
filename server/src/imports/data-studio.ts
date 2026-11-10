/**
 * Data Studio — XLSX/CSV interchange for the simulators (NOT a system of record and NOT a real integration).
 *
 * upload → parse (no formulas/macros/links executed) → validate (structure, types, enums, keys, references,
 * revisions, domain invariants) → preview diff → explicit confirm → near-atomic commit across both simulator
 * databases with a pre-commit snapshot → independent re-query → history with safe restore.
 */
import ExcelJS from 'exceljs';
import express, { type Request, type Response, type Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { itsmSeed, securitySeed, type ItsmDataset, type SecurityDataset } from '../../../fixtures/seed';
import type { ItsmRepository } from '../../../simulators/itsm/itsm-sim';
import { canonical } from '../../../packages/contracts/src/canonical';
import type { SecurityRepository } from '../../../simulators/security/security-sim';
import type { ScenarioClock } from '../../../simulators/shared/infra';
import type { GateStore } from '../gate/store';
import { LIMITS, SHEET_BY_NAME, SHEETS, WORKBOOK_SCHEMA_VERSION, type SheetName, type SheetSpec } from './workbook-schema';

type Row = Record<string, unknown>;

export interface Issue {
  sheet: string | null;
  row: number | null;
  column: string | null;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

interface RawSheet {
  sheet: SheetName;
  headers: string[];
  rows: Array<{ rowNumber: number; cells: Row }>;
}

type Outcome = 'ADDED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED';

export interface SheetPreview {
  added: number;
  updated: number;
  unchanged: number;
  rejected: number;
  removed: number;
  rows: Array<{ rowNumber: number; key: string; outcome: Outcome; changes?: string[] }>;
}

export interface PreviewResult {
  importId: string;
  fileName: string;
  fileSha256: string;
  mode: 'merge' | 'replace';
  canCommit: boolean;
  sheets: Partial<Record<SheetName, SheetPreview>>;
  issues: Issue[];
  warnings: string[];
  sideEffects: string[];
}

export class DataStudioError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

interface Deps {
  securityRepo: SecurityRepository;
  itsmRepo: ItsmRepository;
  store: GateStore;
  clock: ScenarioClock;
  dataDir: string;
  onCommitted?: () => void;
}

const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

export class DataStudio {
  constructor(private d: Deps) {}

  // ------------------------------------------------------------------ parsing
  async parseXlsx(buf: Buffer): Promise<{ sheets: RawSheet[]; issues: Issue[] }> {
    const issues: Issue[] = [];
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new DataStudioError(400, 'NOT_XLSX', 'File is not a valid .xlsx (zip) workbook');
    if (buf.includes(Buffer.from('vbaProject.bin'))) throw new DataStudioError(400, 'MACROS_NOT_ALLOWED', 'Macro-enabled workbooks are rejected; save as .xlsx without macros');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch (e) {
      throw new DataStudioError(400, 'UNREADABLE_WORKBOOK', `Workbook could not be read: ${(e as Error).message}`);
    }
    if (wb.worksheets.length > LIMITS.maxSheets) throw new DataStudioError(400, 'TOO_MANY_SHEETS', `At most ${LIMITS.maxSheets} sheets are allowed`);

    const meta = wb.getWorksheet('_meta');
    if (meta) {
      const v = Number(meta.getCell('B1').value);
      if (v !== WORKBOOK_SCHEMA_VERSION) issues.push(issue(null, null, null, 'SCHEMA_VERSION_UNSUPPORTED', `Workbook schema version ${String(meta.getCell('B1').value)} is not supported (expected ${WORKBOOK_SCHEMA_VERSION})`));
    } else {
      issues.push({ ...issue(null, null, null, 'SCHEMA_VERSION_MISSING', `No _meta sheet; assuming schema version ${WORKBOOK_SCHEMA_VERSION}`), severity: 'warning' });
    }

    const sheets: RawSheet[] = [];
    for (const ws of wb.worksheets) {
      const spec = SHEET_BY_NAME.get(ws.name as SheetName);
      if (!spec) {
        if (!['README', 'Schema', '_meta', 'ApprovalPackets'].includes(ws.name)) issues.push({ ...issue(ws.name, null, null, 'UNKNOWN_SHEET', `Sheet "${ws.name}" is not part of the schema and was ignored`), severity: 'warning' });
        continue;
      }
      if (ws.actualColumnCount > LIMITS.maxColumns) {
        issues.push(issue(ws.name, null, null, 'TOO_MANY_COLUMNS', `More than ${LIMITS.maxColumns} columns`));
        continue;
      }
      const headerRow = ws.getRow(1);
      const headers: string[] = [];
      headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
        headers[col] = String(cellText(cell.value) ?? '').trim();
      });
      const rows: RawSheet['rows'] = [];
      const lastRow = ws.actualRowCount;
      if (lastRow - 1 > LIMITS.maxRowsPerSheet) {
        issues.push(issue(ws.name, null, null, 'TOO_MANY_ROWS', `More than ${LIMITS.maxRowsPerSheet} data rows`));
        continue;
      }
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const cells: Row = {};
        let any = false;
        row.eachCell({ includeEmpty: false }, (cell, col) => {
          const header = headers[col];
          if (!header) return;
          const { value, problem } = convertCell(cell.value);
          if (problem) issues.push({ ...issue(ws.name, rowNumber, header, problem.code, problem.message), severity: problem.severity });
          if (value !== null && value !== '') any = true;
          cells[header] = value;
        });
        if (any) rows.push({ rowNumber, cells });
      });
      sheets.push({ sheet: spec.sheet, headers: headers.filter(Boolean), rows });
    }
    return { sheets, issues };
  }

  parseCsv(buf: Buffer, sheet: SheetName): { sheets: RawSheet[]; issues: Issue[] } {
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const records = parseCsvText(text);
    if (records.length === 0) throw new DataStudioError(400, 'EMPTY_FILE', 'CSV is empty');
    const headers = records[0]!.map((h) => h.trim());
    if (headers.length > LIMITS.maxColumns) throw new DataStudioError(400, 'TOO_MANY_COLUMNS', `More than ${LIMITS.maxColumns} columns`);
    if (records.length - 1 > LIMITS.maxRowsPerSheet) throw new DataStudioError(400, 'TOO_MANY_ROWS', `More than ${LIMITS.maxRowsPerSheet} data rows`);
    const issues: Issue[] = [];
    const rows: RawSheet['rows'] = [];
    records.slice(1).forEach((rec, i) => {
      if (rec.every((c) => c.trim() === '')) return;
      const cells: Row = {};
      headers.forEach((h, j) => {
        let v: string = rec[j] ?? '';
        if (/^'[=+\-@\t\r]/.test(v)) v = v.slice(1);
        else if (/^=/.test(v)) issues.push({ ...issue(sheet, i + 2, h, 'FORMULA_LIKE_TEXT', 'Value begins with "=" and is stored as plain text; it is never evaluated'), severity: 'warning' });
        cells[h] = v === '' ? null : v;
      });
      rows.push({ rowNumber: i + 2, cells });
    });
    return { sheets: [{ sheet, headers, rows }], issues };
  }

  // ------------------------------------------------------------------ validation + diff
  private currentDataset(): SecurityDataset & ItsmDataset {
    return { ...this.d.securityRepo.snapshot(), ...this.d.itsmRepo.snapshot() };
  }

  validate(parsed: { sheets: RawSheet[]; issues: Issue[] }, mode: 'merge' | 'replace') {
    const issues = [...parsed.issues];
    const current = this.currentDataset();
    const present = new Set(parsed.sheets.map((s) => s.sheet));

    if (mode === 'replace') {
      for (const spec of SHEETS) if (!present.has(spec.sheet)) issues.push(issue(spec.sheet, null, null, 'MISSING_SHEET', `Replace mode requires every sheet; "${spec.sheet}" is missing`));
    }
    if (parsed.sheets.length === 0) issues.push(issue(null, null, null, 'NO_DATA_SHEETS', 'No recognised data sheets were found'));

    // 1. Structure, coercion, schema and duplicate keys.
    const valid = new Map<SheetName, Array<{ rowNumber: number; row: Row; revisionProvided: number | null }>>();
    const rejectedRows = new Set<string>(); // `${sheet}:${rowNumber}`
    for (const raw of parsed.sheets) {
      const spec = SHEET_BY_NAME.get(raw.sheet)!;
      for (const col of spec.columns.filter((c) => c.required)) {
        if (!raw.headers.includes(col.name)) issues.push(issue(raw.sheet, 1, col.name, 'MISSING_COLUMN', `Required column "${col.name}" is missing`));
      }
      for (const h of raw.headers) if (!spec.columns.some((c) => c.name === h)) issues.push({ ...issue(raw.sheet, 1, h, 'UNKNOWN_COLUMN', `Column "${h}" is not in the schema and was ignored`), severity: 'warning' });
      if (issues.some((i) => i.sheet === raw.sheet && i.code === 'MISSING_COLUMN')) {
        raw.rows.forEach((r) => rejectedRows.add(`${raw.sheet}:${r.rowNumber}`));
        continue;
      }
      const keyCount = new Map<string, number>();
      for (const r of raw.rows) keyCount.set(String(r.cells[spec.key] ?? ''), (keyCount.get(String(r.cells[spec.key] ?? '')) ?? 0) + 1);
      const out: Array<{ rowNumber: number; row: Row; revisionProvided: number | null }> = [];
      for (const r of raw.rows) {
        const cellIssues = issues.filter((i) => i.sheet === raw.sheet && i.row === r.rowNumber && i.severity === 'error');
        const { row, problems } = coerceRow(spec, r.cells);
        const rowIssues = [...problems.map((p) => issue(raw.sheet, r.rowNumber, p.column, p.code, p.message))];
        const key = String(r.cells[spec.key] ?? '');
        if (key && (keyCount.get(key) ?? 0) > 1) rowIssues.push(issue(raw.sheet, r.rowNumber, spec.key, 'DUPLICATE_KEY', `Duplicate ${spec.key} "${key}" appears ${keyCount.get(key)} times in this sheet`));
        const revisionProvided = spec.revisionColumn && typeof row[spec.revisionColumn] === 'number' ? (row[spec.revisionColumn] as number) : null;
        if (spec.revisionColumn && row[spec.revisionColumn] === undefined) row[spec.revisionColumn] = 1;
        const parsedRow = spec.schema.safeParse(row);
        if (!parsedRow.success) {
          for (const zi of parsedRow.error.issues) rowIssues.push(issue(raw.sheet, r.rowNumber, String(zi.path[0] ?? ''), zi.code === 'invalid_value' ? 'INVALID_ENUM' : 'INVALID_VALUE', zi.message));
        }
        issues.push(...rowIssues);
        if (rowIssues.length > 0 || cellIssues.length > 0) {
          rejectedRows.add(`${raw.sheet}:${r.rowNumber}`);
          continue;
        }
        out.push({ rowNumber: r.rowNumber, row: parsedRow.success ? (parsedRow.data as Row) : row, revisionProvided });
      }
      valid.set(raw.sheet, out);
    }

    // 2. Referential integrity (cascading until stable). Merge mode may reference existing records.
    let changed = true;
    while (changed) {
      changed = false;
      for (const spec of SHEETS) {
        const rows = valid.get(spec.sheet);
        if (!rows) continue;
        for (const ref of spec.refs) {
          const target = SHEET_BY_NAME.get(ref.sheet)!;
          const keys = new Set<string>((valid.get(ref.sheet) ?? []).map((r) => String(r.row[target.key])));
          if (mode === 'merge') for (const rec of current[target.datasetKey as keyof typeof current] as Row[]) keys.add(String(rec[target.key]));
          for (const r of [...rows]) {
            const v = r.row[ref.column];
            if (v === null || v === undefined || keys.has(String(v))) continue;
            if (ref.severity === 'warning') {
              if (!issues.some((i) => i.sheet === spec.sheet && i.row === r.rowNumber && i.code === 'UNRESOLVED_REFERENCE')) {
                issues.push({ ...issue(spec.sheet, r.rowNumber, ref.column, 'UNRESOLVED_REFERENCE', `${ref.column} "${String(v)}" does not exist in ${ref.sheet} (cross-system reference; allowed)`), severity: 'warning' });
              }
              continue;
            }
            issues.push(issue(spec.sheet, r.rowNumber, ref.column, 'ORPHAN_REFERENCE', `${ref.column} "${String(v)}" does not exist in ${ref.sheet}`));
            rows.splice(rows.indexOf(r), 1);
            rejectedRows.add(`${spec.sheet}:${r.rowNumber}`);
            changed = true;
          }
        }
      }
    }

    // 3. Diff against current state, enforcing optimistic concurrency on versioned entities.
    const sheets: Partial<Record<SheetName, SheetPreview>> = {};
    const toWrite: Partial<Record<SheetName, Row[]>> = {};
    for (const raw of parsed.sheets) {
      const spec = SHEET_BY_NAME.get(raw.sheet)!;
      const existing = new Map((current[spec.datasetKey as keyof typeof current] as Row[]).map((r) => [String(r[spec.key]), r]));
      const preview: SheetPreview = { added: 0, updated: 0, unchanged: 0, rejected: 0, removed: 0, rows: [] };
      const writes: Row[] = [];
      for (const r of raw.rows) {
        if (rejectedRows.has(`${raw.sheet}:${r.rowNumber}`)) {
          preview.rejected++;
          preview.rows.push({ rowNumber: r.rowNumber, key: String(r.cells[spec.key] ?? ''), outcome: 'REJECTED' });
        }
      }
      for (const v of valid.get(raw.sheet) ?? []) {
        const key = String(v.row[spec.key]);
        const cur = existing.get(key);
        const rc = spec.revisionColumn;
        if (!cur) {
          const row = rc ? { ...v.row, [rc]: mode === 'replace' && v.revisionProvided ? v.revisionProvided : 1 } : v.row;
          writes.push(row);
          preview.added++;
          preview.rows.push({ rowNumber: v.rowNumber, key, outcome: 'ADDED' });
          continue;
        }
        const comparable = rc ? { ...v.row, [rc]: cur[rc] } : v.row;
        const changes = Object.keys(spec.schema instanceof z.ZodObject ? (spec.schema as z.ZodObject).shape : comparable).filter((k) => k !== rc && canonical(comparable[k] ?? null) !== canonical(cur[k] ?? null));
        if (changes.length === 0 && (mode === 'merge' || !rc || v.revisionProvided === null || v.revisionProvided === cur[rc])) {
          if (mode === 'replace') writes.push(rc ? { ...v.row, [rc]: cur[rc] } : v.row);
          preview.unchanged++;
          preview.rows.push({ rowNumber: v.rowNumber, key, outcome: 'UNCHANGED' });
          continue;
        }
        if (mode === 'merge' && rc) {
          if (v.revisionProvided === null) {
            issues.push(issue(raw.sheet, v.rowNumber, rc, 'REVISION_REQUIRED', `Updating existing ${key} requires its current revision (${String(cur[rc])})`));
            preview.rejected++;
            preview.rows.push({ rowNumber: v.rowNumber, key, outcome: 'REJECTED' });
            continue;
          }
          if (v.revisionProvided !== cur[rc]) {
            issues.push(issue(raw.sheet, v.rowNumber, rc, 'STALE_REVISION', `${key} is at revision ${String(cur[rc])} but the file has ${v.revisionProvided}; export a fresh copy and re-apply your edits`));
            preview.rejected++;
            preview.rows.push({ rowNumber: v.rowNumber, key, outcome: 'REJECTED' });
            continue;
          }
        }
        const nextRev = rc ? (mode === 'replace' && v.revisionProvided ? v.revisionProvided : Number(cur[rc]) + 1) : undefined;
        writes.push(rc ? { ...v.row, [rc]: nextRev } : v.row);
        preview.updated++;
        preview.rows.push({ rowNumber: v.rowNumber, key, outcome: 'UPDATED', changes });
      }
      if (mode === 'replace') {
        const fileKeys = new Set((valid.get(raw.sheet) ?? []).map((v) => String(v.row[spec.key])));
        preview.removed = [...existing.keys()].filter((k) => !fileKeys.has(k)).length;
      }
      preview.rows.sort((a, b) => a.rowNumber - b.rowNumber);
      sheets[raw.sheet] = preview;
      toWrite[raw.sheet] = writes;
    }

    // 4. Domain warnings about how the Gate will interpret the data.
    const warnings: string[] = [];
    const after = projected(current, toWrite, mode);
    const ics = after.users.filter((u) => u.role === 'INCIDENT_COMMANDER' && u.onCall && u.active);
    if (ics.length !== 1) warnings.push(`${ics.length} active on-call incident commanders after import; the Gate will refuse to stage packets (APPROVERS_UNRESOLVED) until exactly one exists.`);
    const byMachine = new Map<string, string[]>();
    for (const ci of after.configItems) if (ci.machineId) byMachine.set(ci.machineId, [...(byMachine.get(ci.machineId) ?? []), ci.ciId]);
    for (const [m, cis] of byMachine) if (cis.length > 1) warnings.push(`${cis.join(', ')} all claim device ${m}; the Gate will treat identity as AMBIGUOUS.`);
    for (const ci of after.configItems) {
      const dev = after.devices.find((dd) => dd.machineId === ci.machineId);
      if (dev && dev.computerDnsName.toLowerCase() !== ci.hostname.toLowerCase()) warnings.push(`${ci.ciId} hostname ${ci.hostname} differs from Defender name ${dev.computerDnsName}; identity will be AMBIGUOUS.`);
    }

    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const totalChanges = Object.values(sheets).reduce((n, s) => n + (s?.added ?? 0) + (s?.updated ?? 0) + (s?.removed ?? 0), 0);
    const sideEffects =
      mode === 'replace'
        ? ['Replaces all simulator records with the file contents.', 'Clears all Gate requests, approval packets, notifications and machine actions (workflow state).']
        : ['Upserts the rows marked ADDED/UPDATED. Nothing is deleted. Existing approval packets and Gate requests are kept.'];
    return { sheets, issues, warnings, toWrite, canCommit: errorCount === 0 && (totalChanges > 0 || mode === 'replace'), sideEffects };
  }

  // ------------------------------------------------------------------ preview / commit
  async preview(buf: Buffer, fileName: string, mode: 'merge' | 'replace', actor: string, entity?: string): Promise<PreviewResult> {
    if (buf.length > LIMITS.maxFileBytes) throw new DataStudioError(413, 'FILE_TOO_LARGE', `Files are limited to ${LIMITS.maxFileBytes / 1024 / 1024} MB`);
    if (buf.length === 0) throw new DataStudioError(400, 'EMPTY_FILE', 'The uploaded file is empty');
    const lower = fileName.toLowerCase();
    let parsed: { sheets: RawSheet[]; issues: Issue[] };
    if (lower.endsWith('.xlsx')) parsed = await this.parseXlsx(buf);
    else if (lower.endsWith('.csv')) {
      const spec = SHEETS.find((s2) => s2.sheet.toLowerCase() === String(entity ?? '').toLowerCase());
      if (!spec) throw new DataStudioError(400, 'ENTITY_REQUIRED', `CSV imports need an entity: ${SHEETS.map((s2) => s2.sheet).join(', ')}`);
      if (mode === 'replace') throw new DataStudioError(400, 'REPLACE_REQUIRES_WORKBOOK', 'Replace mode needs a full .xlsx workbook; CSV supports merge only');
      parsed = this.parseCsv(buf, spec.sheet);
    } else throw new DataStudioError(400, 'UNSUPPORTED_FILE_TYPE', 'Only .xlsx and .csv files are accepted (.xlsm, .xls and others are rejected)');

    const v = this.validate(parsed, mode);
    const importId = `IMP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const fileSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const result: PreviewResult = { importId, fileName: fileName.slice(0, 200), fileSha256, mode, canCommit: v.canCommit, sheets: v.sheets, issues: v.issues.slice(0, 500), warnings: v.warnings, sideEffects: v.sideEffects };
    this.d.store.db
      .prepare('INSERT INTO imports (import_id, file_name, file_sha256, mode, status, actor, summary, preview, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(importId, result.fileName, fileSha256, mode, 'PREVIEWED', actor, JSON.stringify(summarize(result)), JSON.stringify({ result, parsed }), this.d.clock.nowIso());
    return result;
  }

  commit(importId: string, actor: string) {
    const row = this.d.store.db.prepare('SELECT * FROM imports WHERE import_id = ?').get(importId) as Row | undefined;
    if (!row) throw new DataStudioError(404, 'IMPORT_NOT_FOUND', `Import ${importId} not found`);
    if (row.status !== 'PREVIEWED') throw new DataStudioError(409, 'IMPORT_NOT_PENDING', `Import ${importId} is ${String(row.status)}`);
    const stored = JSON.parse(String(row.preview)) as { result: PreviewResult; parsed: { sheets: RawSheet[]; issues: Issue[] } };
    const mode = stored.result.mode;
    // Re-validate against the CURRENT state: records may have changed since the preview.
    const v = this.validate(stored.parsed, mode);
    if (!v.canCommit || summaryKey(v.sheets) !== summaryKey(stored.result.sheets)) {
      this.d.store.db.prepare("UPDATE imports SET status='SUPERSEDED' WHERE import_id=?").run(importId);
      throw new DataStudioError(409, 'STALE_PREVIEW', 'Data changed since the preview (or the preview had errors). Upload the file again to get a fresh preview.', { sheets: v.sheets, issues: v.issues.slice(0, 50) });
    }

    // Pre-commit snapshot enables safe restore from history.
    const backupDir = path.join(this.d.dataDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `${importId}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ security: this.d.securityRepo.snapshot(), itsm: this.d.itsmRepo.snapshot(), takenAt: this.d.clock.nowIso() }));

    const sec: Partial<SecurityDataset> = {};
    const itsm: Partial<ItsmDataset> = {};
    for (const [sheet, rows] of Object.entries(v.toWrite) as Array<[SheetName, Row[]]>) {
      const spec = SHEET_BY_NAME.get(sheet)!;
      (spec.system === 'security' ? (sec as Row) : (itsm as Row))[spec.datasetKey] = rows;
    }
    this.applyAcrossSystems(mode, sec, itsm);
    if (mode === 'replace') this.d.store.resetAll();

    // Independent re-query: every written row must now read back identically.
    const now = this.currentDataset();
    let verified = 0;
    const mismatches: string[] = [];
    for (const [sheet, rows] of Object.entries(v.toWrite) as Array<[SheetName, Row[]]>) {
      const spec = SHEET_BY_NAME.get(sheet)!;
      const live = new Map((now[spec.datasetKey as keyof typeof now] as Row[]).map((r) => [String(r[spec.key]), r]));
      for (const r of rows) {
        const got = live.get(String(r[spec.key]));
        if (got && canonical(pick(got, Object.keys(r))) === canonical(r)) verified++;
        else mismatches.push(`${sheet}:${String(r[spec.key])}`);
      }
    }
    const summary = { ...summarize({ ...stored.result, sheets: v.sheets }), verifiedRows: verified, mismatches };
    this.d.store.db
      .prepare("UPDATE imports SET status=?, summary=?, backup_dir=?, committed_at=? WHERE import_id=?")
      .run(mismatches.length ? 'COMMITTED_WITH_MISMATCHES' : 'COMMITTED', JSON.stringify(summary), backupFile, this.d.clock.nowIso(), importId);
    this.d.store.audit(actor, 'DATA_IMPORT_COMMITTED', null, { importId, mode, fileSha256: stored.result.fileSha256, verified, mismatches: mismatches.length });
    this.d.onCommitted?.();
    return { importId, status: mismatches.length ? 'COMMITTED_WITH_MISMATCHES' : 'COMMITTED', summary };
  }

  /** Writes to both simulator databases inside open transactions; commits only when both succeed. */
  private applyAcrossSystems(mode: 'merge' | 'replace', sec: Partial<SecurityDataset>, itsm: Partial<ItsmDataset>) {
    const sdb = this.d.securityRepo.db;
    const idb = this.d.itsmRepo.db;
    sdb.exec('BEGIN IMMEDIATE');
    idb.exec('BEGIN IMMEDIATE');
    try {
      if (mode === 'replace') {
        this.d.securityRepo.replaceAll(sec as SecurityDataset);
        this.d.itsmRepo.replaceAll(itsm as ItsmDataset);
      } else {
        this.d.securityRepo.upsertDataset(sec);
        this.d.itsmRepo.upsertDataset(itsm);
      }
      idb.exec('COMMIT');
    } catch (e) {
      if (idb.inTransaction) idb.exec('ROLLBACK');
      if (sdb.inTransaction) sdb.exec('ROLLBACK');
      throw new DataStudioError(500, 'COMMIT_FAILED', `Import rolled back in both simulators: ${(e as Error).message}`);
    }
    try {
      sdb.exec('COMMIT');
    } catch (e) {
      // Extremely unlikely after a successful ITSM commit; recorded for manual restore from the backup.
      throw new DataStudioError(500, 'PARTIAL_COMMIT', `ITSM committed but security commit failed (${(e as Error).message}). Restore from import history.`);
    }
  }

  discard(importId: string) {
    this.d.store.db.prepare("UPDATE imports SET status='DISCARDED' WHERE import_id=? AND status='PREVIEWED'").run(importId);
  }

  history() {
    return (this.d.store.db.prepare('SELECT import_id, file_name, file_sha256, mode, status, actor, summary, backup_dir, created_at, committed_at FROM imports ORDER BY created_at DESC, rowid DESC LIMIT 50').all() as Row[]).map((r) => ({
      importId: r.import_id,
      fileName: r.file_name,
      fileSha256: r.file_sha256,
      mode: r.mode,
      status: r.status,
      actor: r.actor,
      summary: JSON.parse(String(r.summary)),
      restorable: !!r.backup_dir && fs.existsSync(String(r.backup_dir)),
      createdAt: r.created_at,
      committedAt: r.committed_at,
    }));
  }

  /** Restores the dataset as it was immediately BEFORE the given import. Clears workflow state. */
  restore(importId: string, actor: string) {
    const row = this.d.store.db.prepare('SELECT backup_dir FROM imports WHERE import_id = ?').get(importId) as Row | undefined;
    if (!row?.backup_dir || !fs.existsSync(String(row.backup_dir))) throw new DataStudioError(404, 'NO_BACKUP', 'No pre-commit snapshot exists for this import');
    const snap = JSON.parse(fs.readFileSync(String(row.backup_dir), 'utf8')) as { security: SecurityDataset; itsm: ItsmDataset; takenAt: string };
    this.applyAcrossSystems('replace', snap.security, snap.itsm);
    this.d.store.resetAll();
    const id = `IMP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    this.d.store.db
      .prepare('INSERT INTO imports (import_id, file_name, file_sha256, mode, status, actor, summary, preview, created_at, committed_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, `restore of ${importId}`, '-', 'restore', 'COMMITTED', actor, JSON.stringify({ restoredFrom: importId, snapshotTakenAt: snap.takenAt }), '{}', this.d.clock.nowIso(), this.d.clock.nowIso());
    this.d.store.audit(actor, 'DATA_RESTORED', null, { importId, snapshotTakenAt: snap.takenAt });
    this.d.onCommitted?.();
    return { restoredFrom: importId, snapshotTakenAt: snap.takenAt };
  }

  // ------------------------------------------------------------------ export
  async buildWorkbook(source: 'current' | 'template'): Promise<Buffer> {
    const data = source === 'template' ? { ...securitySeed, ...itsmSeed } : this.currentDataset();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Business Impact Gate (synthetic)';
    wb.created = new Date(this.d.clock.nowMs());
    const readme = wb.addWorksheet('README');
    readme.columns = [{ width: 120 }];
    [
      'Business Impact Gate: simulator dataset workbook (schema v1). ALL DATA IS SYNTHETIC.',
      source === 'template' ? 'This is the sample dataset shipped with the prototype.' : `Exported from the running simulators at ${this.d.clock.nowIso()} (scenario clock).`,
      'Each data sheet maps to one simulator entity. See the "Schema" sheet for every column, type, requirement and allowed value.',
      'Dates/times: enter as TEXT in ISO-8601 with an explicit timezone, e.g. 2026-10-18T06:14:00Z. Native Excel date cells are rejected (they carry no timezone).',
      'Formulas, macros and external links are never executed; formula cells are rejected. Values starting with = + - @ are exported with a leading apostrophe.',
      'Merge mode upserts rows and never deletes. To update Incidents/Devices/ConfigItems keep the "revision" column as exported; stale revisions are rejected.',
      'Replace mode loads the whole workbook as the new dataset and clears workflow state (requests, approval packets).',
      'Import is interchange for a simulator, not a real integration and not a system of record.',
    ].forEach((t) => readme.addRow([t]));
    const meta = wb.addWorksheet('_meta');
    meta.addRow(['schemaVersion', WORKBOOK_SCHEMA_VERSION]);
    meta.addRow(['generatedFrom', source]);
    const schema = wb.addWorksheet('Schema');
    schema.addRow(['sheet', 'column', 'type', 'required', 'editable', 'allowedValues', 'primaryKey', 'references', 'description']);
    for (const spec of SHEETS) {
      for (const c of spec.columns) {
        const ref = spec.refs.find((r) => r.column === c.name);
        schema.addRow([spec.sheet, c.name, c.type, c.required ? 'yes' : 'no', c.editable ? 'yes' : 'system-managed', c.allowed?.join(' | ') ?? '', spec.key === c.name ? 'yes' : '', ref ? `${ref.sheet} (${ref.severity})` : '', c.description]);
      }
    }
    styleHeader(schema);
    for (const spec of SHEETS) {
      const ws = wb.addWorksheet(spec.sheet);
      ws.columns = spec.columns.map((c) => ({ header: c.name, key: c.name, width: c.type === 'text' ? 80 : Math.max(14, c.name.length + 4), style: { numFmt: c.type === 'datetime' || c.type === 'string' ? '@' : undefined } }));
      for (const rec of data[spec.datasetKey as keyof typeof data] as Row[]) {
        ws.addRow(Object.fromEntries(spec.columns.map((c) => [c.name, exportValue(rec[c.name])])));
      }
      styleHeader(ws);
    }
    if (source === 'current') {
      const ap = wb.addWorksheet('ApprovalPackets');
      ap.addRow(['READ-ONLY system records, ignored on import']);
      ap.addRow(['approvalId', 'status', 'incidentId', 'machineId', 'ciId', 'approverIds', 'reasonCodes', 'createdAt', 'expiresAt', 'decisions']);
      for (const p of this.d.itsmRepo.listPackets()) {
        ap.addRow([p.approvalId, p.status, p.incidentId, p.machineId, p.ciId, p.approverIds.join(','), p.reasonCodes.join(','), p.createdAt, p.expiresAt, p.decisions.map((x) => `${x.approverId}:${x.decision}`).join(',')].map(exportValue));
      }
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  exportCsv(sheet: SheetName): string {
    const spec = SHEET_BY_NAME.get(sheet);
    if (!spec) throw new DataStudioError(404, 'UNKNOWN_ENTITY', `Unknown entity ${sheet}`);
    const data = this.currentDataset()[spec.datasetKey as keyof SecurityDataset & keyof ItsmDataset] as Row[];
    const lines = [spec.columns.map((c) => c.name).join(',')];
    for (const r of data) lines.push(spec.columns.map((c) => csvCell(exportValue(r[c.name]))).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  records(sheet: string, q: string) {
    const needle = q.trim().toLowerCase();
    let rows: Row[];
    if (sheet === 'ApprovalPackets') rows = this.d.itsmRepo.listPackets().map(({ idempotencyKey: _k, ...p }) => p as Row);
    else {
      const spec = SHEET_BY_NAME.get(sheet as SheetName);
      if (!spec) throw new DataStudioError(404, 'UNKNOWN_ENTITY', `Unknown entity ${sheet}`);
      rows = this.currentDataset()[spec.datasetKey as keyof SecurityDataset & keyof ItsmDataset] as Row[];
    }
    const filtered = needle ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle)) : rows;
    return { total: rows.length, value: filtered.slice(0, 500) };
  }
}

// ------------------------------------------------------------------ helpers
function issue(sheet: string | null, row: number | null, column: string | null, code: string, message: string): Issue {
  return { sheet, row, column, code, message, severity: 'error' };
}

function cellText(v: unknown): unknown {
  if (v && typeof v === 'object' && 'richText' in v) return (v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('');
  return v;
}

function convertCell(v: ExcelJS.CellValue): { value: unknown; problem?: { code: string; message: string; severity: 'error' | 'warning' } } {
  if (v === null || v === undefined) return { value: null };
  if (typeof v === 'string') return { value: /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v };
  if (typeof v === 'number' || typeof v === 'boolean') return { value: v };
  if (v instanceof Date) return { value: null, problem: { code: 'NATIVE_DATE_NOT_ALLOWED', message: 'Native Excel date cells have no timezone; enter ISO-8601 text such as 2026-10-18T06:14:00Z', severity: 'error' } };
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return { value: null, problem: { code: 'FORMULA_NOT_ALLOWED', message: 'Formula cells are rejected; paste values only', severity: 'error' } };
    if ('richText' in v) return { value: cellText(v) };
    if ('hyperlink' in v) return { value: (v as { text?: string }).text ?? null, problem: { code: 'HYPERLINK_IGNORED', message: 'Hyperlink target ignored; only the cell text was imported', severity: 'warning' } };
    if ('error' in v) return { value: null, problem: { code: 'CELL_ERROR', message: `Cell contains an Excel error (${String((v as { error: unknown }).error)})`, severity: 'error' } };
  }
  return { value: null, problem: { code: 'UNSUPPORTED_CELL', message: 'Unsupported cell content', severity: 'error' } };
}

function coerceRow(spec: SheetSpec, cells: Row): { row: Row; problems: Array<{ column: string; code: string; message: string }> } {
  const row: Row = {};
  const problems: Array<{ column: string; code: string; message: string }> = [];
  for (const c of spec.columns) {
    let v = cells[c.name];
    if (typeof v === 'string') v = c.type === 'text' ? v : v.trim();
    if (v === null || v === undefined || v === '') {
      if (c.nullable) row[c.name] = null;
      else if (c.required) problems.push({ column: c.name, code: 'REQUIRED', message: `${c.name} is required` });
      continue;
    }
    if (typeof v === 'string' && v.length > LIMITS.maxCellChars) {
      problems.push({ column: c.name, code: 'TOO_LONG', message: `${c.name} exceeds ${LIMITS.maxCellChars} characters` });
      continue;
    }
    switch (c.type) {
      case 'integer': {
        const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : NaN;
        if (!Number.isInteger(n)) problems.push({ column: c.name, code: 'WRONG_TYPE', message: `${c.name} must be a whole number, got "${String(v)}"` });
        else row[c.name] = n;
        break;
      }
      case 'boolean': {
        const b = typeof v === 'boolean' ? v : /^(true|1|yes)$/i.test(String(v)) ? true : /^(false|0|no)$/i.test(String(v)) ? false : null;
        if (b === null) problems.push({ column: c.name, code: 'WRONG_TYPE', message: `${c.name} must be TRUE or FALSE, got "${String(v)}"` });
        else row[c.name] = b;
        break;
      }
      case 'datetime':
        if (typeof v === 'number') problems.push({ column: c.name, code: 'NATIVE_DATE_NOT_ALLOWED', message: `${c.name} looks like a native Excel date/serial number, which has no timezone; enter ISO-8601 text such as 2026-10-18T06:14:00Z` });
        else if (typeof v !== 'string') problems.push({ column: c.name, code: 'WRONG_TYPE', message: `${c.name} must be ISO-8601 text with timezone` });
        else row[c.name] = v;
        break;
      case 'enum':
        if (!c.allowed!.includes(String(v))) problems.push({ column: c.name, code: 'INVALID_ENUM', message: `${c.name} "${String(v)}" is not one of ${c.allowed!.join(', ')}` });
        else row[c.name] = String(v);
        break;
      default:
        row[c.name] = typeof v === 'number' ? String(v) : v;
    }
  }
  return { row, problems };
}

function projected(current: SecurityDataset & ItsmDataset, writes: Partial<Record<SheetName, Row[]>>, mode: 'merge' | 'replace') {
  const out = { ...current } as SecurityDataset & ItsmDataset;
  for (const [sheet, rows] of Object.entries(writes) as Array<[SheetName, Row[]]>) {
    const spec = SHEET_BY_NAME.get(sheet)!;
    const k = spec.datasetKey as keyof typeof out;
    if (mode === 'replace') (out as unknown as Row)[k] = rows;
    else {
      const map = new Map((out[k] as Row[]).map((r) => [String(r[spec.key]), r]));
      for (const r of rows) map.set(String(r[spec.key]), r);
      (out as unknown as Row)[k] = [...map.values()];
    }
  }
  return out;
}

function summarize(r: PreviewResult) {
  return {
    mode: r.mode,
    canCommit: r.canCommit,
    errors: r.issues.filter((i) => i.severity === 'error').length,
    warnings: r.issues.filter((i) => i.severity === 'warning').length + r.warnings.length,
    sheets: Object.fromEntries(Object.entries(r.sheets).map(([k, v]) => [k, { added: v!.added, updated: v!.updated, unchanged: v!.unchanged, rejected: v!.rejected, removed: v!.removed }])),
  };
}
const summaryKey = (sheets: Partial<Record<SheetName, SheetPreview>>) =>
  canonical(Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, [v!.added, v!.updated, v!.unchanged, v!.rejected, v!.removed]])));

const pick = (o: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

/** OWASP CSV/formula-injection mitigation: prefix dangerous leading characters with an apostrophe. */
export function exportValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s2 = String(v);
  return DANGEROUS_PREFIX.test(s2) ? `'${s2}` : s2;
}

function csvCell(v: string | number | boolean | null): string {
  if (v === null) return '';
  const s2 = String(v);
  return /[",\r\n]/.test(s2) ? `"${s2.replace(/"/g, '""')}"` : s2;
}

export function parseCsvText(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

function styleHeader(ws: ExcelJS.Worksheet) {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// ------------------------------------------------------------------ routes
export function mountDataRoutes(api: Router, studio: DataStudio, user: (req: Request) => string | undefined) {
  const send = (res: Response, e: unknown) => {
    if (e instanceof DataStudioError) return res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details ?? null } });
    throw e;
  };
  const actorOf = (req: Request) => user(req) ?? 'anonymous-demo';
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response, next: (e?: unknown) => void) => {
    try {
      await fn(req, res);
    } catch (e) {
      try {
        send(res, e);
      } catch (e2) {
        next(e2);
      }
    }
  };
  const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  api.get('/data/schema', (_req, res) => res.json({ version: WORKBOOK_SCHEMA_VERSION, limits: LIMITS, sheets: SHEETS.map(({ schema: _s, ...rest }) => rest) }));
  api.get(
    '/data/template.xlsx',
    wrap(async (_req, res) => {
      res.setHeader('content-type', xlsxType);
      res.setHeader('content-disposition', 'attachment; filename="containment-assurance-sample.xlsx"');
      res.send(await studio.buildWorkbook('template'));
    }),
  );
  api.get(
    '/data/export.xlsx',
    wrap(async (_req, res) => {
      res.setHeader('content-type', xlsxType);
      res.setHeader('content-disposition', 'attachment; filename="containment-assurance-export.xlsx"');
      res.send(await studio.buildWorkbook('current'));
    }),
  );
  api.get(
    '/data/export/:sheet.csv',
    wrap((req, res) => {
      const csv = studio.exportCsv(String(req.params.sheet) as SheetName);
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${String(req.params.sheet)}.csv"`);
      res.send(csv);
    }),
  );
  api.post(
    '/data/import/preview',
    express.raw({ type: 'application/octet-stream', limit: LIMITS.maxFileBytes }),
    wrap(async (req, res) => {
      const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
      const fileName = typeof req.query.fileName === 'string' ? req.query.fileName : 'upload';
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(await studio.preview(body, fileName, mode, actorOf(req), typeof req.query.entity === 'string' ? req.query.entity : undefined));
    }),
  );
  api.post(
    '/data/import/:id/commit',
    wrap((req, res) => {
      if (req.body?.confirm !== true) throw new DataStudioError(400, 'CONFIRMATION_REQUIRED', 'Send {"confirm": true} to commit an import');
      res.json(studio.commit(String(req.params.id), actorOf(req)));
    }),
  );
  api.post(
    '/data/import/:id/discard',
    wrap((req, res) => {
      studio.discard(String(req.params.id));
      res.json({ ok: true });
    }),
  );
  api.get('/data/imports', wrap((_req, res) => res.json({ value: studio.history() })));
  api.post(
    '/data/imports/:id/restore',
    wrap((req, res) => {
      if (req.body?.confirm !== true) throw new DataStudioError(400, 'CONFIRMATION_REQUIRED', 'Send {"confirm": true} to restore');
      res.json(studio.restore(String(req.params.id), actorOf(req)));
    }),
  );
  api.get(
    '/data/records/:sheet',
    wrap((req, res) => res.json(studio.records(String(req.params.sheet), typeof req.query.q === 'string' ? req.query.q : ''))),
  );
}
