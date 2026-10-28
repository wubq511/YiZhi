/** Explicit per-process and per-thread capabilities; normal CLI login stays in place. */
export const READ_ONLY_CONFIG: Record<string, boolean | number | string> = {
  'features.shell_tool': false, 'features.unified_exec': false, 'features.apply_patch_freeform': false,
  'features.apps': false, 'features.plugins': false, 'features.multi_agent': false,
  'features.hooks': false, 'features.goals': false, 'features.memories': false,
  'features.request_permissions_tool': false, 'skills.bundled.enabled': false,
  'features.view_image': false, web_search: 'disabled', project_doc_max_bytes: 0,
};
export const readOnlyCLIArgs = Object.entries(READ_ONLY_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
