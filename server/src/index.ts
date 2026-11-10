import { BOOTSTRAP_HINT, productionProblems } from './ops/production';
import { createSystem } from './system';

// CH-22: in production, stop with a clear message instead of starting on a bad data directory or an empty database.
if (process.env.NODE_ENV === 'production') {
  const problems = productionProblems(process.env);
  if (problems.length) {
    for (const p of problems) console.error(`[containment-assurance] START REFUSED: ${p}`);
    process.exit(1);
  }
}
const system = createSystem();
if (system.config.production && system.securityRepo.listIncidents().length === 0) {
  console.error(`[containment-assurance] START REFUSED: ${BOOTSTRAP_HINT}`);
  system.close();
  process.exit(1);
}
const { url } = await system.start();
console.info(`[containment-assurance] Gate API + simulators listening on ${url} (mode=${system.config.integrationMode}, clock=${system.config.clockMode})`);
if (system.setupError()) console.warn(`[containment-assurance] SETUP REQUIRED: ${system.setupError()!.message}. Missing: ${system.setupError()!.missing.join(', ')}`);
console.info('[containment-assurance] All records are SYNTHETIC. This is not a Microsoft or ServiceNow product.');

const shutdown = () => {
  system.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
