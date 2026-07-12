// Config boundary for command-line entrypoints. Diagnostic modes get concise setup guidance;
// normal services retain the strict loadConfig failure and never start with absent/bad config.

import { formatConfigError, isConfigError, loadConfig } from "./paperclip.mjs";

export function loadConfigForCli({ diagnostic = false } = {}) {
  try {
    return loadConfig();
  } catch (error) {
    if (diagnostic && isConfigError(error)) {
      console.error(formatConfigError(error));
      process.exit(1);
    }
    throw error;
  }
}
