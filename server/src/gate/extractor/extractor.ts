/**
 * Operational-constraint extraction — the ONLY place language understanding is used.
 *
 * Output is a set of cited CLAIMS. It cannot mark anything safe, choose an action or change policy:
 * the strict schema has no field for that, and every citation is re-verified against the source text.
 */
import { OperationalConstraintExtraction, type DocumentRow } from '../../../../packages/contracts/src/domain';

export interface ExtractionContext {
  hostname: string;
}

export interface UntrustedInstruction {
  documentId: string;
  quote: string;
}

export interface ExtractionResult {
  provider: string;
  extraction: OperationalConstraintExtraction;
  untrustedInstructions: UntrustedInstruction[];
  verificationNotes: string[];
}

export interface ConstraintExtractor {
  readonly name: string;
  extract(docs: DocumentRow[], ctx: ExtractionContext): Promise<ExtractionResult>;
}

export class ExtractorConfigError extends Error {}

/** Instruction-like text inside untrusted documents/telemetry. Detected, recorded, never obeyed. */
const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /\bsystem( override)?\s*:/i,
  /\bmark (this|the) (asset|action|device)[^.]{0,40}\bsafe\b/i,
  /\byou are now\b/i,
  /\boverride (the )?polic(y|ies)\b/i,
  /\bclassify this asset as\b/i,
];

export function findUntrustedInstructions(text: string): string[] {
  return splitSentences(text).filter((s) => INJECTION_PATTERNS.some((p) => p.test(s)));
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NEGATED_APPROVAL = /\b(no|not|without)\b[^.]{0,40}\bapproval\b|\bapproval\b[^.]{0,20}\bnot (required|needed)\b/i;
const OWNER_APPROVAL = /\bowner\b[^.]{0,60}\b(approve|approval)\b|\b(approve|approval)\b[^.]{0,60}\bowner\b/i;
const ESCALATION = /\bescalate to (the )?([^.]+?)\s+before\b/i;
const WINDOW = /(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\s*UTC/;
const FREEZE = /\b(change freeze|freeze window)\b/i;
const DEPENDENCY = /\b(drop(s)? all|used by all|depends on|dispatches|archives|serves)\b/i;
const HOSTNAME = /\b[A-Z]{2,5}(?:-[A-Z0-9]{2,8}){1,3}\b/g;

/**
 * Deterministic, rules-based extractor for the shipped fixtures. It is NOT a language model and
 * does not generalise to arbitrary prose; it exists so the product runs offline and testably.
 */
export class DeterministicConstraintExtractor implements ConstraintExtractor {
  readonly name = 'deterministic-rules-v1';

  async extract(docs: DocumentRow[], ctx: ExtractionContext): Promise<ExtractionResult> {
    const constraints: OperationalConstraintExtraction['constraints'] = [];
    const ambiguity: string[] = [];
    const untrusted: UntrustedInstruction[] = [];
    let assetRef: string | null = null;

    for (const doc of docs) {
      const positiveOwner: string[] = [];
      const negativeOwner: string[] = [];
      const hostMentions = new Set((doc.body.match(HOSTNAME) ?? []).filter((h) => /^(PRD|WKS|STG|DEV)-/.test(h)));
      for (const h of hostMentions) {
        if (h.toLowerCase() === ctx.hostname.toLowerCase()) assetRef = h;
        else ambiguity.push(`${doc.documentId} refers to ${h}, but the target device is ${ctx.hostname}`);
      }
      for (const sentence of splitSentences(doc.body)) {
        if (INJECTION_PATTERNS.some((p) => p.test(sentence))) {
          untrusted.push({ documentId: doc.documentId, quote: sentence });
          continue; // never treated as a constraint, never obeyed
        }
        const cite = { sourceDocumentId: doc.documentId, sourceVersion: String(doc.version), quote: sentence, confidence: 0.9 };
        if (NEGATED_APPROVAL.test(sentence)) {
          negativeOwner.push(sentence);
          continue;
        }
        if (OWNER_APPROVAL.test(sentence)) {
          positiveOwner.push(sentence);
          const network = /\b(network|isolat|interrupt)/i.test(sentence);
          constraints.push({ category: 'OWNER_APPROVAL', normalizedValue: network ? 'SERVICE_OWNER_APPROVAL_BEFORE_NETWORK_INTERRUPTION' : 'SERVICE_OWNER_APPROVAL', ...cite });
        }
        const esc = ESCALATION.exec(sentence);
        if (esc) constraints.push({ category: 'OWNER_APPROVAL', normalizedValue: `ESCALATE_BEFORE_NETWORK_CHANGE: ${esc[2]!.trim()}`.slice(0, 160), ...cite });
        const win = WINDOW.exec(sentence);
        if (win) constraints.push({ category: 'SERVICE_WINDOW', normalizedValue: `NO_INTERRUPTION ${win[1]}-${win[2]} UTC`, ...cite });
        if (FREEZE.test(sentence)) constraints.push({ category: 'CHANGE_FREEZE', normalizedValue: 'CHANGE_FREEZE_REFERENCED', ...cite });
        if (DEPENDENCY.test(sentence)) {
          const norm = /drop/i.test(sentence) ? 'INTERRUPTION_DROPS_ACTIVE_SESSIONS' : 'SERVES_DEPENDENT_WORKLOADS';
          constraints.push({ category: 'DEPENDENCY_NOTE', normalizedValue: norm, ...cite });
        }
      }
      if (positiveOwner.length > 0 && negativeOwner.length > 0) {
        ambiguity.push(`${doc.documentId} v${doc.version} contains conflicting owner-approval instructions`);
      }
    }

    const extraction: OperationalConstraintExtraction = {
      assetRef,
      constraints,
      ambiguity,
      abstain: ambiguity.length > 0,
    };
    return verifyExtraction(this.name, extraction, docs, untrusted);
  }
}

/**
 * Deterministic post-verification applied to EVERY extractor (rules or model):
 * schema validity, citation exists in the cited document+version, confidence floor.
 * Any unverifiable citation forces abstention — the model cannot introduce facts.
 */
export function verifyExtraction(provider: string, raw: unknown, docs: DocumentRow[], untrusted: UntrustedInstruction[] = []): ExtractionResult {
  const notes: string[] = [];
  const parsed = OperationalConstraintExtraction.safeParse(raw);
  if (!parsed.success) {
    return {
      provider,
      extraction: { assetRef: null, constraints: [], ambiguity: ['Extractor output failed strict schema validation'], abstain: true },
      untrustedInstructions: untrusted,
      verificationNotes: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`],
    };
  }
  const ex = parsed.data;
  const kept: typeof ex.constraints = [];
  let fabricated = false;
  for (const c of ex.constraints) {
    const doc = docs.find((d) => d.documentId === c.sourceDocumentId);
    if (!doc) {
      fabricated = true;
      notes.push(`dropped: cites unknown document ${c.sourceDocumentId}`);
      continue;
    }
    if (String(doc.version) !== c.sourceVersion) {
      fabricated = true;
      notes.push(`dropped: cites ${c.sourceDocumentId} v${c.sourceVersion} but current version is v${doc.version}`);
      continue;
    }
    if (!doc.body.includes(c.quote)) {
      fabricated = true;
      notes.push(`dropped: quote not found verbatim in ${c.sourceDocumentId}`);
      continue;
    }
    if (findUntrustedInstructions(c.quote).length > 0) {
      notes.push(`dropped: quote from ${c.sourceDocumentId} is instruction-like untrusted text`);
      continue;
    }
    if (c.confidence < 0.7) {
      notes.push(`dropped: confidence ${c.confidence} below 0.7 for ${c.category}`);
      ex.ambiguity.push(`Low-confidence ${c.category} claim in ${c.sourceDocumentId}`);
      continue;
    }
    kept.push(c);
  }
  if (fabricated) ex.ambiguity.push('One or more citations could not be verified against the source document');
  notes.push(`verified ${kept.length}/${ex.constraints.length} cited constraints`);
  return {
    provider,
    extraction: { ...ex, constraints: kept, abstain: ex.abstain || fabricated || ex.ambiguity.length > 0 },
    untrustedInstructions: untrusted,
    verificationNotes: notes,
  };
}
