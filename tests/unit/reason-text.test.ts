/** Product-clarity CH-8: the approver sees the Gate's own reason sentences, never a different paraphrase. */
import { describe, expect, it } from 'vitest';
import { REASON_TEXT } from '../../server/src/gate/policy';
import { reasonText } from '../../app/src/reasonText';

describe('reason text for approvers', () => {
  it('is exactly the policy sentence for every known code', () => {
    for (const [code, text] of Object.entries(REASON_TEXT)) expect(reasonText(code)).toBe(text);
  });
  it('turns an unknown code into words instead of hiding it', () => {
    expect(reasonText('SOME_NEW_CODE')).toBe('Some new code');
  });
});
