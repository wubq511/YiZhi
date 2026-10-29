import { isAbsolute } from 'node:path';
export interface FinalAcceptanceInput {
  schema: 'yizhi-t28-final-input-1'; parentConfirmedFinal: true; parentFinalEvidence: string;
  t25FinalSHA: string; t26FinalSHA: string; integrationSHA: string; sourceSHA: string;
  app: string; growthCourse: string; migratedCourse: string;
}
/** A run contract supplied only after the parent's explicit final integration decision.
 * It records that decision; it is never a course authority/publication marker. */
export function validateFinalInput(value: unknown): FinalAcceptanceInput {
  const input = value as FinalAcceptanceInput;
  if (input?.schema !== 'yizhi-t28-final-input-1' || input.parentConfirmedFinal !== true) throw new Error('Parent final integration confirmation is required; checkpoints are not final inputs');
  for (const key of ['t25FinalSHA', 't26FinalSHA', 'integrationSHA', 'sourceSHA'] as const)
    if (!/^[a-f0-9]{40}$/.test(input[key] ?? '')) throw new Error('Missing final commit: ' + key);
  for (const key of ['parentFinalEvidence', 'app', 'growthCourse', 'migratedCourse'] as const)
    if (typeof input[key] !== 'string' || !isAbsolute(input[key])) throw new Error('Expected absolute path: ' + key);
  return input;
}
