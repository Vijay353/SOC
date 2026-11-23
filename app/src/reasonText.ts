/**
 * Product-clarity CH-8: plain words for reason codes, taken from the server policy's own REASON_TEXT so the approver
 * reads exactly the sentence the Gate recorded. Nothing is rewritten or added here. Unknown codes fall back to words.
 */
import { REASON_TEXT } from '../../server/src/gate/policy';
import { codeWords } from './ui';

export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? codeWords(code);
}
