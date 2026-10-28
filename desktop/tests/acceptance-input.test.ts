import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalInput } from './acceptance-input';

test('final acceptance refuses checkpoint-shaped input and requires explicit parent final union plus delivered artifact identities', () => {
  assert.throws(() => validateFinalInput({ t25FinalSHA: 'a'.repeat(40), app: '/old/YiZhi.app' }), /parent|final/i);
  const valid = { schema: 'yizhi-t28-final-input-1', parentConfirmedFinal: true, parentFinalEvidence: '/scratch/parent-final.md',
    t25FinalSHA: 'a'.repeat(40), t26FinalSHA: 'b'.repeat(40), integrationSHA: 'c'.repeat(40), sourceSHA: 'd'.repeat(40),
    app: '/scratch/YiZhi.app', growthCourse: '/scratch/growth', migratedCourse: '/scratch/published' };
  assert.deepEqual(validateFinalInput(valid), valid);
  assert.throws(() => validateFinalInput({ ...valid, t26FinalSHA: 'checkpoint' }), /t26FinalSHA/);
  assert.throws(() => validateFinalInput({ ...valid, app: 'relative.app' }), /absolute/);
});
