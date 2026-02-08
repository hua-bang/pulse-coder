import { MAX_TOOL_OUTPUT_LENGTH } from "../config";

export const truncateOutput = (output: string): string => {
  if (output.length <= MAX_TOOL_OUTPUT_LENGTH) {
    return output;
  }

  const half = Math.floor(MAX_TOOL_OUTPUT_LENGTH / 2);
  const removed = output.length - MAX_TOOL_OUTPUT_LENGTH;

  return (
    output.slice(0, half) +
    `\n\n... [truncated ${removed} characters] ...\n\n` +
    output.slice(-half)
  );
};
