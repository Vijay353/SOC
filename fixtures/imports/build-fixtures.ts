/**
 * Builds the valid and invalid import fixtures from the generated template, so the fixtures always match
 * the current schema. Used by scripts/generate-workbooks.ts (writes files) and by the tests (in memory).
 */
import ExcelJS from 'exceljs';

export type FixtureName =
  | 'valid-fix-stale-mes-cmdb'
  | 'invalid-missing-sheet'
  | 'invalid-wrong-types'
  | 'invalid-duplicate-ids'
  | 'invalid-orphan-reference'
  | 'invalid-status'
  | 'invalid-formula-cell'
  | 'invalid-native-date'
  | 'invalid-stale-revision';

async function load(template: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template as unknown as ArrayBuffer);
  return wb;
}

function findRow(ws: ExcelJS.Worksheet, column: string, value: string): ExcelJS.Row {
  const headers = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  const col = headers.indexOf(column);
  let found: ExcelJS.Row | null = null;
  ws.eachRow((row, n) => {
    if (n > 1 && String(row.getCell(col).value) === value) found = row;
  });
  if (!found) throw new Error(`row ${column}=${value} not found in ${ws.name}`);
  return found;
}
function set(ws: ExcelJS.Worksheet, row: ExcelJS.Row, column: string, value: ExcelJS.CellValue) {
  const headers = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  row.getCell(headers.indexOf(column)).value = value;
}

/** Keeps only the named data sheets (plus _meta) so a merge touches exactly what the fixture is about. */
function only(wb: ExcelJS.Workbook, keep: string[]) {
  for (const ws of [...wb.worksheets]) if (!keep.includes(ws.name) && ws.name !== '_meta') wb.removeWorksheet(ws.id);
}

export async function buildFixture(template: Buffer, name: FixtureName): Promise<Buffer> {
  const wb = await load(template);
  switch (name) {
    case 'valid-fix-stale-mes-cmdb': {
      // A CMDB owner re-verifies the MES record: refresh lastVerifiedAt, keep the exported revision.
      only(wb, ['ConfigItems']);
      const ws = wb.getWorksheet('ConfigItems')!;
      set(ws, findRow(ws, 'ciId', 'CI-007120'), 'lastVerifiedAt', '2026-10-18T06:05:00Z');
      break;
    }
    case 'invalid-missing-sheet':
      wb.removeWorksheet(wb.getWorksheet('Users')!.id);
      break;
    case 'invalid-wrong-types': {
      only(wb, ['DeviceActivity', 'Users']);
      const ws = wb.getWorksheet('DeviceActivity')!;
      set(ws, findRow(ws, 'machineId', 'device-d8f92a10'), 'activeSessionCount', 'lots');
      const us = wb.getWorksheet('Users')!;
      set(us, findRow(us, 'userId', 'analyst-li'), 'onCall', 'maybe');
      break;
    }
    case 'invalid-duplicate-ids': {
      only(wb, ['Devices']);
      const ws = wb.getWorksheet('Devices')!;
      const src = findRow(ws, 'machineId', 'device-91aa02fe');
      ws.addRow((src.values as unknown[]).slice(1));
      break;
    }
    case 'invalid-orphan-reference': {
      only(wb, ['Alerts', 'Dependencies']);
      const ws = wb.getWorksheet('Alerts')!;
      ws.addRow(['ALR-ORPHAN-1', 'INC-00000', 'device-d8f92a10', 'DEFENDER_ENDPOINT', 'Alert for a missing incident', '', '2026-10-18T06:00:00Z']);
      const deps = wb.getWorksheet('Dependencies')!;
      deps.addRow(['DEP-ORPHAN-1', 'CI-404', 'Workflow on a missing CI', 'CRITICAL', 'ACTIVE']);
      break;
    }
    case 'invalid-status': {
      only(wb, ['Incidents']);
      const ws = wb.getWorksheet('Incidents')!;
      set(ws, findRow(ws, 'incidentId', 'INC-90484'), 'status', 'closed');
      set(ws, findRow(ws, 'incidentId', 'INC-90484'), 'revision', 3);
      break;
    }
    case 'invalid-formula-cell': {
      only(wb, ['ConfigItems']);
      const ws = wb.getWorksheet('ConfigItems')!;
      set(ws, findRow(ws, 'ciId', 'CI-020455'), 'businessService', { formula: 'HYPERLINK("http://example.invalid","click")', result: 'click' } as ExcelJS.CellFormulaValue);
      break;
    }
    case 'invalid-native-date': {
      only(wb, ['ChangeFreezes']);
      const ws = wb.getWorksheet('ChangeFreezes')!;
      set(ws, findRow(ws, 'freezeId', 'FRZ-2210'), 'endsAt', new Date('2026-10-19T06:00:00Z'));
      break;
    }
    case 'invalid-stale-revision': {
      // Someone edits an old export: CI-009481 is at revision 3 in the CMDB, the file says 2.
      only(wb, ['ConfigItems']);
      const ws = wb.getWorksheet('ConfigItems')!;
      const row = findRow(ws, 'ciId', 'CI-009481');
      set(ws, row, 'tier', 'TIER_3');
      set(ws, row, 'revision', 2);
      break;
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const FIXTURE_NAMES: FixtureName[] = [
  'valid-fix-stale-mes-cmdb',
  'invalid-missing-sheet',
  'invalid-wrong-types',
  'invalid-duplicate-ids',
  'invalid-orphan-reference',
  'invalid-status',
  'invalid-formula-cell',
  'invalid-native-date',
  'invalid-stale-revision',
];
