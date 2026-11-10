/**
 * Fails if secrets or server-only configuration leak into the browser bundle or committed source.
 * Usage: npm run secret-scan (run after `npm run build`).
 */
import fs from 'node:fs';
import path from 'node:path';

const failures: string[] = [];
const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'data', 'test-results', 'playwright-report'].includes(e.name)) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
};

// 1. Browser bundle must not contain server-only env names, tokens or provider endpoints.
const dist = path.resolve('app/dist');
if (!fs.existsSync(dist)) failures.push('app/dist missing — run `npm run build` first');
const FORBIDDEN_IN_BUNDLE = ['ANTHROPIC_API_KEY', 'MS_CLIENT_SECRET', 'SERVICENOW_PASSWORD', 'SIM_ADMIN_TOKEN', 'SIM_GATE_', 'api.anthropic.com', 'x-api-key', 'Bearer '];
for (const f of walk(dist).filter((x) => /\.(js|html|css|map)$/.test(x))) {
  const text = fs.readFileSync(f, 'utf8');
  for (const needle of FORBIDDEN_IN_BUNDLE) if (text.includes(needle)) failures.push(`${path.relative('.', f)} contains "${needle}"`);
}

// 2. Committed source must not contain credential-shaped values (dummies in .env.example are allowed).
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['Anthropic key', /sk-ant-(?!dummy)[A-Za-z0-9_-]{20,}/],
  ['AWS key', /AKIA[0-9A-Z]{16}/],
  ['Private key', /-----BEGIN (RSA |EC )?PRIVATE KEY-----/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}/],
  ['Generic bearer literal', /Bearer [A-Za-z0-9]{32,}/],
];
const sourceFiles = walk(path.resolve('.')).filter((f) => /\.(ts|tsx|js|json|md|html|css|example)$/.test(f) && !f.includes(`${path.sep}app${path.sep}dist`) && !f.endsWith('package-lock.json'));
for (const f of sourceFiles) {
  const text = fs.readFileSync(f, 'utf8');
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) failures.push(`${path.relative('.', f)} matches ${name}`);
}
if (fs.existsSync('.env')) console.warn('note: a local .env exists (gitignored) — it was not scanned');

if (failures.length) {
  console.error(`secret-scan FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.info(`secret-scan passed: ${walk(dist).length} bundle files and ${sourceFiles.length} source files checked`);
