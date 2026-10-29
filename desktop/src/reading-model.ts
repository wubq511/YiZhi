import type { ReadingBlock } from './shared';

/** Existing block identities in reading order, including prepared material descendants. */
export function unitBlocks(unit?: { reading: { blocks: ReadingBlock[] } }): ReadingBlock[] {
  const result: ReadingBlock[] = [];
  const walk = (blocks: ReadingBlock[]) => { for (const block of blocks) { result.push(block); walk(block.children ?? []); } };
  walk(unit?.reading.blocks ?? []);
  return result;
}
