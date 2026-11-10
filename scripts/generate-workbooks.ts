/**
 * Writes the sample workbook, per-entity CSVs and the valid/invalid import fixtures from the canonical schema.
 * Usage: npm run generate:workbooks
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture, FIXTURE_NAMES } from '../fixtures/imports/build-fixtures';
import { createSystem } from '../server/src/system';
import { SHEETS } from '../server/src/imports/workbook-schema';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-gen-'));
const system = createSystem({ dataDir: tmp, clockMode: 'frozen' }, {});
const { DataStudio } = await import('../server/src/imports/data-studio');
const studio = new DataStudio({ securityRepo: system.securityRepo, itsmRepo: system.itsmRepo, store: system.store, clock: system.clock, dataDir: tmp });

const templates = path.resolve('data/templates');
fs.mkdirSync(path.join(templates, 'csv'), { recursive: true });
fs.mkdirSync(path.resolve('fixtures/imports/files'), { recursive: true });

const template = await studio.buildWorkbook('template');
fs.writeFileSync(path.join(templates, 'containment-assurance-sample.xlsx'), template);
for (const s of SHEETS) fs.writeFileSync(path.join(templates, 'csv', `${s.sheet}.csv`), studio.exportCsv(s.sheet));
for (const name of FIXTURE_NAMES) fs.writeFileSync(path.resolve('fixtures/imports/files', `${name}.xlsx`), await buildFixture(template, name));

system.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.info(`Wrote data/templates/containment-assurance-sample.xlsx, ${SHEETS.length} CSVs, and ${FIXTURE_NAMES.length} fixtures in fixtures/imports/files/`);
