/**
 * OPT-IN scenario fixtures (V3). They are merged on top of the base seed only when someone loads them
 * (Simulator Lab, or POST /api/lab/scenarios/:name). The base seed and its verified outcomes never change.
 * All records are SYNTHETIC.
 */
import type { SecurityDataset } from '../seed';

export interface OptionalScenario {
  name: string;
  label: string;
  description: string;
  security: Partial<SecurityDataset>;
  queueLabels: Array<{ incidentId: string; machineId: string; label: string }>;
}

export const OPTIONAL_SCENARIOS: OptionalScenario[] = [
  {
    name: 'possible-duplicate',
    label: 'Second incident on the same device',
    description:
      'Adds INC-90488 (SAP gateway) and INC-90489 (finance workstation). Each targets a device that already has an incident in the base seed, so a second isolation request can be checked as a possible duplicate.',
    security: {
      incidents: [
        { incidentId: 'INC-90488', displayName: 'Suspicious service installation on SAP gateway', severity: 'high', status: 'active', createdDateTime: '2026-10-18T06:05:00Z', lastUpdateDateTime: '2026-10-18T06:10:00Z', revision: 3 },
        { incidentId: 'INC-90489', displayName: 'Macro-launched script on finance workstation', severity: 'medium', status: 'active', createdDateTime: '2026-10-18T06:08:00Z', lastUpdateDateTime: '2026-10-18T06:10:00Z', revision: 2 },
      ],
      alerts: [
        { alertId: 'ALR-551801', incidentId: 'INC-90488', machineId: 'device-d8f92a10', source: 'DEFENDER_ENDPOINT', title: 'New service installed from a temporary folder', description: 'Service binary written to a user temp path.', detectedAt: '2026-10-18T06:05:00Z' },
        { alertId: 'ALR-551902', incidentId: 'INC-90489', machineId: 'device-91aa02fe', source: 'DEFENDER_ENDPOINT', title: 'Office macro launched a script interpreter', description: 'Macro started a scripting host.', detectedAt: '2026-10-18T06:08:00Z' },
      ],
    },
    queueLabels: [
      { incidentId: 'INC-90488', machineId: 'device-d8f92a10', label: 'Optional: second incident, SAP gateway' },
      { incidentId: 'INC-90489', machineId: 'device-91aa02fe', label: 'Optional: second incident, workstation' },
    ],
  },
];
