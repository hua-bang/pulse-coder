import z from "zod";
import { readFileSync, writeFileSync } from "fs";
import type { Tool } from "../shared/types";
import { truncateOutput } from "./utils";

export const EditTool: Tool<
  { filePath: string; oldString: string; newString: string; replaceAll?: boolean },
  { success: boolean; replacements: number; preview?: string }
> = {
  name: 'edit',
  description: 'Performs exact string replacements in files. Use this to edit existing files by replacing old_string with new_string.',
  inputSchema: z.object({
    filePath: z.string().describe('The absolute path to the file to modify'),
    oldString: z.string().describe('The exact text to replace (must match exactly)'),
    newString: z.string().describe('The text to replace it with (must be different from old_string)'),
    replaceAll: z.boolean().optional().default(false).describe('Replace all occurrences of old_string (default false)'),
  }),
  execute: async ({ filePath, oldString, newString, replaceAll = false }) => {
    // Validate that old and new strings are different
    if (oldString === newString) {
      throw new Error('old_string and new_string must be different');
    }

    // Read the file
    const content = readFileSync(filePath, 'utf-8');

    // Check if oldString exists in the file
    if (!content.includes(oldString)) {
      throw new Error(`old_string not found in file: ${filePath}`);
    }

    let newContent: string;
    let replacements = 0;

    if (replaceAll) {
      // Replace all occurrences
      const parts = content.split(oldString);
      replacements = parts.length - 1;
      newContent = parts.join(newString);
    } else {
      // Replace only the first occurrence
      const index = content.indexOf(oldString);
      if (index === -1) {
        throw new Error(`old_string not found in file: ${filePath}`);
      }

      // Check if the string is unique (appears only once)
      const secondIndex = content.indexOf(oldString, index + oldString.length);
      if (secondIndex !== -1) {
        throw new Error(
          'old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.'
        );
      }

      newContent = content.slice(0, index) + newString + content.slice(index + oldString.length);
      replacements = 1;
    }

    // Write the modified content back
    writeFileSync(filePath, newContent, 'utf-8');

    // Generate a preview of the changes (show the changed section with context)
    const changedIndex = newContent.indexOf(newString);
    const contextLength = 200;
    const start = Math.max(0, changedIndex - contextLength);
    const end = Math.min(newContent.length, changedIndex + newString.length + contextLength);
    const preview = truncateOutput(
      `...${newContent.slice(start, end)}...`
    );

    return {
      success: true,
      replacements,
      preview,
    };
  },
};

export default EditTool;
