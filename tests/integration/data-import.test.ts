/**
 * G3 — Excel/CSV interchange: template, validation, preview, confirm, commit, re-query, export safety,
 * history/restore, and the end-to-end effect of imported data on the Gate's decisions.
 */
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFixture, type FixtureName } from '../../fixtures/imports/build-fixtures';
import { startHarness, type Harness, type Json } from '../helpers';

let h: Harness;
let template: Buffer;
beforeEach(async () => {
  h = await startHarness();
  template = Buffer.from(await (await fetch(`${h.url}/api/data/template.xlsx`)).arrayBuffer());
});
afterEach(async () => {
  await h.close();
});

const preview = async (buf: Buffer, fileName: string, params: Record<string, string> = {}) => {
  const q = new URLSearchParams({ fileName, mode: 'merge', ...params });
  const res = await fetch(`${h.url}/api/data/import/preview?${q}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-demo-user': 'analyst-priya' }, body: new Uint8Array(buf) });
  return { status: res.status, body: (await res.json()) as Json };
};
const commit = (id: string, confirm = true) => h.api<Json>('POST', `/api/data/import/${id}/commit`, { confirm });
const fixture = (n: FixtureName) => buildFixture(template, n);
const codes = (body: Json) => body.issues.filter((i: Json) => i.severity === 'error').map((i: Json) => i.code);

describe('template and schema', () => {
  it('serves a versioned workbook with README, Schema, _meta and one sheet per entity', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['README', '_meta', 'Schema', 'Incidents', 'Devices', 'Alerts', 'DeviceActivity', 'Users', 'ConfigItems', 'Dependencies', 'ChangeFreezes', 'Documents']);
    expect(wb.getWorksheet('_meta')!.getCell('B1').value).toBe(1);
    expect(wb.getWorksheet('Dependencies')!.actualRowCount).toBe(1 + 26);
  });

  it('re-importing the unmodified template in merge mode is an idempotent no-op', async () => {
    const p = await preview(template, 'sample.xlsx');
    expect(p.status).toBe(200);
    expect(codes(p.body)).toEqual([]);
    const totals = Object.values(p.body.sheets as Record<string, Json>).reduce((a: number, s: Json) => a + s.added + s.updated, 0);
    expect(totals).toBe(0);
    expect(p.body.canCommit).toBe(false); // nothing to change
  });
});

describe('valid import changes simulator state and the next Gate decision', () => {
  it('re-verifying the stale MES CMDB record turns INSUFFICIENT_EVIDENCE into REQUIRE_DUAL_APPROVAL', async () => {
    const before = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-mes-a', incidentId: 'INC-90483', machineId: 'device-3be1c771', requestedAction: 'FULL_ISOLATION' });
    expect(before.body.view.evaluation.decision).toBe('INSUFFICIENT_EVIDENCE');

    const p = await preview(await fixture('valid-fix-stale-mes-cmdb'), 'fix.xlsx');
    expect(p.body.canCommit).toBe(true);
    expect(p.body.sheets.ConfigItems).toMatchObject({ added: 0, updated: 1, rejected: 0 });
    expect(p.body.sheets.ConfigItems.rows.find((r: Json) => r.outcome === 'UPDATED').changes).toEqual(['lastVerifiedAt']);

    expect((await commit(p.body.importId, false)).status).toBe(400); // explicit confirmation required
    const c = await commit(p.body.importId);
    expect(c.status).toBe(200);
    expect(c.body.summary).toMatchObject({ verifiedRows: 1, mismatches: [] });
    expect(h.system.itsmRepo.getBundle('CI-007120')!.configItem).toMatchObject({ lastVerifiedAt: '2026-10-18T06:05:00Z', revision: 9 });

    const after = await h.api<Json>('POST', `/api/requests/${before.body.requestId}/evaluate`);
    expect(after.body.evaluation.decision).toBe('REQUIRE_DUAL_APPROVAL');
    expect(after.body.evaluation.approverIds).toEqual(['soc-incident-commander', 'owner-mes']);
  });

  it('a committed preview cannot be committed twice; a re-upload of the same file is unchanged', async () => {
    const buf = await fixture('valid-fix-stale-mes-cmdb');
    const p = await preview(buf, 'fix.xlsx');
    await commit(p.body.importId);
    expect((await commit(p.body.importId)).body.error.code).toBe('IMPORT_NOT_PENDING');
    const again = await preview(buf, 'fix.xlsx');
    // Same file now carries a stale revision (8 vs 9) for a row whose other fields already match → unchanged.
    expect(again.body.sheets.ConfigItems).toMatchObject({ updated: 0, unchanged: 1 + 6, rejected: 0 });
  });

  it('a preview is invalidated if the data changes before commit', async () => {
    const p = await preview(await fixture('valid-fix-stale-mes-cmdb'), 'fix.xlsx');
    const other = await preview(await fixture('valid-fix-stale-mes-cmdb'), 'fix-copy.xlsx');
    await commit(other.body.importId);
    const late = await commit(p.body.importId);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('STALE_PREVIEW');
  });
});

describe('invalid files are rejected with row/column errors and change nothing', () => {
  const cases: Array<[FixtureName, Record<string, string>, string[]]> = [
    ['invalid-missing-sheet', { mode: 'replace' }, ['MISSING_SHEET']],
    ['invalid-wrong-types', {}, ['WRONG_TYPE']],
    ['invalid-duplicate-ids', {}, ['DUPLICATE_KEY']],
    ['invalid-orphan-reference', {}, ['ORPHAN_REFERENCE']],
    ['invalid-status', {}, ['INVALID_ENUM']],
    ['invalid-formula-cell', {}, ['FORMULA_NOT_ALLOWED']],
    ['invalid-native-date', {}, ['NATIVE_DATE_NOT_ALLOWED']],
    ['invalid-stale-revision', {}, ['STALE_REVISION']],
  ];
  for (const [name, params, expected] of cases) {
    it(name, async () => {
      const before = JSON.stringify({ s: h.system.securityRepo.snapshot(), i: h.system.itsmRepo.snapshot() });
      const p = await preview(await fixture(name), `${name}.xlsx`, params);
      expect(p.status).toBe(200);
      expect(p.body.canCommit).toBe(false);
      for (const code of expected) expect(codes(p.body)).toContain(code);
      const located = p.body.issues.find((i: Json) => expected.includes(i.code));
      expect(located.message.length).toBeGreaterThan(5);
      if (name !== 'invalid-missing-sheet') expect(located.row).toBeGreaterThan(1);
      const c = await commit(p.body.importId);
      expect(c.status).toBe(409);
      expect(JSON.stringify({ s: h.system.securityRepo.snapshot(), i: h.system.itsmRepo.snapshot() })).toBe(before);
    });
  }

  it('wrong-types reports each bad cell by sheet, row and column', async () => {
    const p = await preview(await fixture('invalid-wrong-types'), 'x.xlsx');
    const located = p.body.issues.filter((i: Json) => i.code === 'WRONG_TYPE').map((i: Json) => `${i.sheet}!${i.column}`);
    expect(located).toEqual(expect.arrayContaining(['DeviceActivity!activeSessionCount', 'Users!onCall']));
  });

  it('rejects oversized, macro-enabled, non-xlsx and unsupported uploads', async () => {
    const big = await preview(Buffer.alloc(5 * 1024 * 1024 + 10, 65), 'big.xlsx');
    expect(big.status).toBe(413);
    expect((await preview(Buffer.from('PK\u0003\u0004 xl/vbaProject.bin'), 'macro.xlsx')).body.error.code).toBe('MACROS_NOT_ALLOWED');
    expect((await preview(Buffer.from('not a zip'), 'fake.xlsx')).body.error.code).toBe('NOT_XLSX');
    expect((await preview(template, 'book.xlsm')).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await preview(Buffer.alloc(0), 'empty.xlsx')).body.error.code).toBe('EMPTY_FILE');
  });
});

describe('CSV import', () => {
  it('merges a single entity and validates references against existing records', async () => {
    const csv = 'dependencyId,ciId,workflowName,criticality,status\r\nDEP-NEW-1,CI-020455,"Payroll export, nightly",CRITICAL,ACTIVE\r\nDEP-NEW-2,CI-NOPE,Ghost,CRITICAL,ACTIVE\r\n';
    const p = await preview(Buffer.from(csv), 'Dependencies.csv', { entity: 'Dependencies' });
    expect(p.body.sheets.Dependencies).toMatchObject({ added: 1, rejected: 1 });
    expect(codes(p.body)).toEqual(['ORPHAN_REFERENCE']);
    expect(p.body.canCommit).toBe(false); // all-or-nothing: fix the file first
    const fixed = await preview(Buffer.from(csv.split('\r\n').slice(0, 2).join('\r\n')), 'Dependencies.csv', { entity: 'Dependencies' });
    expect(fixed.body.canCommit).toBe(true);
    await commit(fixed.body.importId);
    expect(h.system.itsmRepo.getBundle('CI-020455')!.dependencies.map((d) => d.workflowName)).toEqual(['Payroll export, nightly']);
  });

  it('requires an entity and refuses replace mode', async () => {
    expect((await preview(Buffer.from('a,b\r\n1,2'), 'x.csv')).body.error.code).toBe('ENTITY_REQUIRED');
    expect((await preview(Buffer.from('a,b\r\n1,2'), 'x.csv', { entity: 'Users', mode: 'replace' })).body.error.code).toBe('REPLACE_REQUIRES_WORKBOOK');
  });
});

describe('export, replace, history and restore', () => {
  it('exports current state with formula-injection protection and round-trips it', async () => {
    h.system.securityRepo.upsertDataset({ alerts: [{ alertId: 'ALR-INJ', incidentId: 'INC-90484', machineId: 'device-91aa02fe', source: 'DEFENDER_ENDPOINT', title: '=HYPERLINK("http://evil.invalid","x")', description: '+cmd|calc', detectedAt: '2026-10-18T06:00:00Z' }] });
    const csv = await (await fetch(`${h.url}/api/data/export/Alerts.csv`)).text();
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.invalid"",""x"")"`);
    expect(csv).toContain("'+cmd|calc");
    const xbuf = Buffer.from(await (await fetch(`${h.url}/api/data/export.xlsx`)).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xbuf as unknown as ArrayBuffer);
    const alerts = wb.getWorksheet('Alerts')!;
    let title: unknown = null;
    alerts.eachRow((r) => {
      if (r.getCell(1).value === 'ALR-INJ') title = r.getCell(5).value;
    });
    expect(title).toBe(`'=HYPERLINK("http://evil.invalid","x")`);
    // Round-trip: the escaped export re-imports to the original value (apostrophe stripped), so nothing changes.
    const p = await preview(xbuf, 'export.xlsx');
    expect(p.body.sheets.Alerts).toMatchObject({ added: 0, updated: 0, rejected: 0 });
    expect(wb.getWorksheet('ApprovalPackets')).toBeTruthy();
  });

  it('replace mode loads a full workbook, clears workflow state, and history can restore the prior dataset', async () => {
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-x', incidentId: 'INC-90482', machineId: 'device-d8f92a10', requestedAction: 'FULL_ISOLATION' });
    await h.api('POST', `/api/requests/${r.body.requestId}/stage`);
    expect(h.system.itsmRepo.listPackets()).toHaveLength(1);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template as unknown as ArrayBuffer);
    const ci = wb.getWorksheet('ConfigItems')!;
    ci.eachRow((row) => {
      if (row.getCell(1).value === 'CI-020455') row.getCell(5).value = 'TIER_1';
    });
    const p = await preview(Buffer.from(await wb.xlsx.writeBuffer()), 'replace.xlsx', { mode: 'replace' });
    expect(p.body.canCommit).toBe(true);
    expect(p.body.sideEffects.join(' ')).toMatch(/Clears all Gate requests/);
    const c = await commit(p.body.importId);
    expect(c.body.status).toBe('COMMITTED');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);
    expect(h.system.store.listRequests()).toHaveLength(0);
    expect(h.system.itsmRepo.getBundle('CI-020455')!.configItem.tier).toBe('TIER_1');

    const hist = await h.api<Json>('GET', '/api/data/imports');
    expect(hist.body.value[0]).toMatchObject({ importId: p.body.importId, status: 'COMMITTED', restorable: true });
    const restored = await h.api<Json>('POST', `/api/data/imports/${p.body.importId}/restore`, { confirm: true });
    expect(restored.status).toBe(200);
    expect(h.system.itsmRepo.getBundle('CI-020455')!.configItem.tier).toBe('TIER_3');
  });

  it('record browser searches simulator records and approval packets', async () => {
    const r = await h.api<Json>('GET', '/api/data/records/Dependencies?q=reconciliation');
    expect(r.body.value.map((x: Json) => x.dependencyId)).toEqual(['DEP-9481-18']);
    expect((await h.api<Json>('GET', '/api/data/records/ApprovalPackets')).body.total).toBe(0);
    expect((await h.api<Json>('GET', '/api/data/records/Nope')).status).toBe(404);
  });
});
