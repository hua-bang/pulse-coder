import z from "zod";
import type { Tool } from "../typings";
import { skillRegistry } from "../skill";

/**
 * Build the tool description dynamically from registered skills.
 * Called lazily so that the registry is already initialized.
 */
function buildDescription(): string {
  const skills = skillRegistry.getAll();

  if (skills.length === 0) {
    return "No skills are currently loaded.";
  }

  const lines = [
    "Load a skill to get detailed step-by-step instructions for a specific task.",
    "Use this when a task matches an available skill's description.",
    "[!important] Follow the skill's guidance carefully once loaded.",
    "",
    "<available_skills>",
    ...skills.flatMap((s) => [
      `  <skill>`,
      `    <name>${s.name}</name>`,
      `    <description>${s.description}</description>`,
      `  </skill>`,
    ]),
    "</available_skills>",
  ];

  return lines.join("\n");
}

interface SkillToolOutput {
  name: string;
  description: string;
  content: string;
  metadata: Record<string, any> | undefined;
}

/**
 * Create the skill tool instance.
 * Must be called **after** skillRegistry.initialize() so the registry is populated.
 */
export function createSkillTool(): Tool<{ name: string }, SkillToolOutput> {
  return {
    name: 'skill',
    description: buildDescription(),
    inputSchema: z.object({
      name: z.string().describe('The name of the skill to load'),
    }),
    execute: async ({ name }): Promise<SkillToolOutput> => {
      // Exact match first
      const exactMatch = skillRegistry.get(name);

      if (exactMatch) {
        return {
          name: exactMatch.name,
          description: exactMatch.description,
          content: exactMatch.content,
          metadata: exactMatch.metadata,
        };
      }

      // Fuzzy fallback
      const matches = skillRegistry.search(name);
      if (matches.length === 1 && matches[0]) {
        return {
          name: matches[0].name,
          description: matches[0].description,
          content: matches[0].content,
          metadata: matches[0].metadata,
        };
      }

      if (matches.length > 1) {
        const names = matches.map((s) => s.name).join(', ');
        throw new Error(`Multiple skills match "${name}": ${names}. Please use the exact name.`);
      }

      const all = skillRegistry.getAll().map((s) => s.name).join(', ');
      throw new Error(`Skill "${name}" not found. Available: ${all}`);
    },
  };
}

export default createSkillTool;
