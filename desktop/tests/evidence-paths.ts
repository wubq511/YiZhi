import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Keep UI evidence with its test, or in an explicitly requested acceptance directory. */
export function evidencePath(filename: string): string {
  const directory = process.env.YIZHI_EVIDENCE_DIR;
  if (!directory) return test.info().outputPath(filename);
  mkdirSync(directory, { recursive: true });
  return resolve(directory, filename);
}
