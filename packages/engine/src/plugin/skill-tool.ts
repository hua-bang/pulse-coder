import type { Tool, SkillInfo } from '../shared/types';
import z from 'zod';

const getSkillsPrompt = (availableSkills: SkillInfo[]) => {
  return [
    "If query matches an available skill's description or instruction [use skill], use the skill tool to get detailed instructions.",
    "Load a skill to get detailed instructions for a specific task.",
    "Skills provide specialized knowledge and step-by-step guidance.",
    "Use this when a task matches an available skill's description.",
    "Only the skills listed here are available:",
    "[!important] You should follow the skill's step-by-step guidance. If the skill is not complete, ask the user for more information.",
    "<available_skills>",
    ...availableSkills.flatMap((skill) => [
      `  <skill>`,
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `  </skill>`,
    ]),
    "</available_skills>",
  ].join(" ");
};

export const generateSkillTool = (skills: SkillInfo[]): Tool<{ name: string }, SkillInfo> => {
  return {
    name: 'skill',
    description: getSkillsPrompt(skills),
    inputSchema: z.object({
      name: z.string().describe('The name of the skill to execute'),
    }),
    execute: async ({ name }) => {
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        throw new Error(`Skill "${name}" not found`);
      }
      return skill;
    },
  };
};
