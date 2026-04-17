import { createLangfusePlugin } from 'pulse-coder-langfuse-plugin';

/**
 * Langfuse observability plugin.
 *
 * Auto-disables when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are missing,
 * so it is safe to always mount.
 *
 * Configure via env:
 *   LANGFUSE_PUBLIC_KEY   (required to activate)
 *   LANGFUSE_SECRET_KEY   (required to activate)
 *   LANGFUSE_HOST         (optional, defaults to Langfuse Cloud)
 *   LANGFUSE_RELEASE      (optional, git sha / version tag)
 */
export const langfusePlugin = createLangfusePlugin({
  tags: ['remote-server'],
});
