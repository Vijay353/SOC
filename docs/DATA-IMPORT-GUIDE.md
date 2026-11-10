# Data import guide (schema v1)

Excel is the editable **interchange** format for the simulators. It is not a system of record, not a real-time feed and not an integration. Implementation: `server/src/imports/` (schema in `workbook-schema.ts`).

## Files

- Sample workbook: `data/templates/containment-assurance-sample.xlsx` (also *Data Studio → Download sample workbook*, `GET /api/data/template.xlsx`)
- Per-entity CSVs: `data/templates/csv/*.csv`
- Valid/invalid fixtures: `fixtures/imports/files/*.xlsx` (regenerate with `npm run generate:workbooks`)

## Workbook layout

`README`, `_meta` (B1 = schema version, must be `1`), `Schema` (every column, type, requirement, editability, allowed values, key, references), then one sheet per entity. `ApprovalPackets` appears in exports as read-only and is ignored on import.

| Sheet | System | Primary key | References | Versioned |
|---|---|---|---|---|
| Incidents | security | incidentId | — | `revision` |
| Devices | security | machineId | — | `revision` |
| Alerts | security | alertId | incidentId → Incidents, machineId → Devices | — |
| DeviceActivity | security | machineId | machineId → Devices | — |
| Users | itsm | userId | — | — |
| ConfigItems | itsm | ciId | ownerUserId → Users; machineId → Devices (*warning only*, cross-system) | `revision` |
| Dependencies | itsm | dependencyId | ciId → ConfigItems | — |
| ChangeFreezes | itsm | freezeId | ciId → ConfigItems | — |
| Documents | itsm | documentId | ciId → ConfigItems | — |

Column-level detail (types, enums, descriptions) is in the workbook's `Schema` sheet and `GET /api/data/schema`.

## Value rules

- **Date/time:** ISO-8601 *text* with explicit zone, e.g. `2026-10-18T06:14:00Z`. Native Excel date cells/serials are rejected (`NATIVE_DATE_NOT_ALLOWED`) because they carry no timezone.
- **Booleans:** `TRUE/FALSE` (also true/false, 1/0, yes/no). **Integers:** whole numbers. **Enums:** exact values from the Schema sheet.
- **Null handling:** blank required cell → `REQUIRED`; `ConfigItems.machineId` may be blank (not linked).
- **Never executed:** formulas (`FORMULA_NOT_ALLOWED`), macros (`.xlsm` or embedded VBA → rejected), hyperlinks (target ignored, text kept, warning), external links.
- **Formula-injection protection:** exports prefix values starting with `= + - @ TAB CR` with `'`; imports strip that one apostrophe, so exports round-trip unchanged.
- **Bounds:** 5 MB file, 20 sheets, 5,000 rows per sheet, 40 columns, 8,000 characters per cell.

## Modes

| Mode | Behaviour |
|---|---|
| **Merge** (default; `.xlsx` or one-entity `.csv`) | Upserts; never deletes. Sheets may be omitted. References may point at existing records. Updating a versioned record requires its **current** `revision` (`REVISION_REQUIRED` / `STALE_REVISION`); successful updates bump it. Unchanged rows are no-ops, so re-importing the same file is idempotent. |
| **Replace** (`.xlsx` only) | Every sheet required (`MISSING_SHEET`). The file becomes the whole dataset; removed counts are previewed. Clears workflow state (Gate requests, approval packets, notifications, machine actions). |

## Pipeline

1. Upload (`POST /api/data/import/preview?fileName=&mode=&entity=`, raw body).
2. Parse safely; validate structure, types, enums, duplicate keys (`DUPLICATE_KEY`, all occurrences rejected), references (`ORPHAN_REFERENCE`, cascading), revisions, domain rules (e.g. `endsAt > startsAt`).
3. Preview: per sheet added / updated (with changed columns) / unchanged / rejected / removed, a located issue list (sheet, row, column, code, message) and **Gate interpretation warnings** (e.g. two CIs claiming one device → identity will be ambiguous; not exactly one on-call incident commander → approvers unresolved).
4. **All-or-nothing:** any error blocks commit. Nothing is silently dropped.
5. Commit requires `{ "confirm": true }`. Data is re-validated against current state; if anything changed since preview → `409 STALE_PREVIEW`.
6. A pre-commit snapshot is saved; both simulator DBs are written inside open transactions and committed together.
7. Every written row is **re-queried** and compared (`verifiedRows`, `mismatches`).
8. History lists imports; *Restore before* returns the dataset to the snapshot taken before that import (clears workflow state). Records are browsable/searchable live; CSV export per entity, XLSX export of everything.

## Negative cases covered by tests

Missing sheet, wrong types, duplicate IDs, orphan references, invalid status, formula cell, native date, stale revision, oversized file, macro-enabled file, non-zip `.xlsx`, unsupported extension, empty file, CSV without entity, CSV replace, stale preview, double commit, repeated import (no-op).
