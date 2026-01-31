import type { FlexibleSchema, ModelMessage } from "ai";
import type z from "zod";

export interface Tool<Input, Output> {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<Input>;
  execute: (input: Input) => Promise<Output>;
}

export interface Context {
  messages: ModelMessage[];
}