import { developmentDirectory } from '../../tools/desktop/paths.mjs';
import { _electron as electron } from '@playwright/test';
import { join } from 'node:path';
import type {} from '../../tools/desktop/controlled-preload';
/** A separate executable and preload; never enables capabilities on the product entry. */
export const controlledElectron = {
  launch(options: NonNullable<Parameters<typeof electron.launch>[0]> = {}) {
    return electron.launch({ ...options, args: [join(developmentDirectory(), 'controlled-main.cjs'), ...(options.args ?? []).slice(1)] });
  },
};
