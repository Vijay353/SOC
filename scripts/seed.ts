/** Reset all three local stores to the synthetic scenario. Usage: npm run seed */
import { createSystem } from '../server/src/system';

const system = createSystem();
system.resetScenario();
const s = system.securityRepo.snapshot();
const i = system.itsmRepo.snapshot();
console.info(`Seeded ${system.config.dataDir}`);
console.info(`  mock-security: ${s.incidents.length} incidents, ${s.devices.length} devices, ${s.alerts.length} alerts`);
console.info(`  mock-itsm:     ${i.configItems.length} CIs, ${i.users.length} users, ${i.dependencies.length} dependencies, ${i.documents.length} documents`);
console.info('  gate:          empty (no requests)');
system.close();
