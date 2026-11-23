/** Product-clarity CH-12: key columns first, nothing invented, nothing lost (hidden columns are reported). */
import { describe, expect, it } from 'vitest';
import { recordColumns } from '../../app/src/recordColumns';

const CONFIG_ITEM = ['ciId', 'name', 'hostname', 'machineId', 'tier', 'businessService', 'environment', 'ownerUserId', 'lastVerifiedAt', 'revision'];

describe('record browser columns', () => {
  it('ConfigItems lead with id, name, hostname, tier, service, owner, last verified', () => {
    const r = recordColumns('ConfigItems', CONFIG_ITEM);
    expect(r.shown).toEqual(['ciId', 'name', 'hostname', 'tier', 'businessService', 'ownerUserId', 'lastVerifiedAt']);
    expect(r.hidden).toEqual(['machineId', 'environment', 'revision']);
  });
  it('never shows a column the data does not have, and every available column is either shown or hidden', () => {
    const r = recordColumns('ConfigItems', ['ciId', 'tier']);
    expect(r.shown).toEqual(['ciId', 'tier']);
    expect([...r.shown, ...r.hidden].sort()).toEqual(['ciId', 'tier']);
  });
  it('an unknown entity keeps the original order', () => {
    expect(recordColumns('Something', ['b', 'a', 'c']).shown).toEqual(['b', 'a', 'c']);
  });
  it('no data gives no columns', () => {
    expect(recordColumns('Users', [])).toEqual({ shown: [], hidden: [] });
  });
});
