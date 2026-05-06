// Shim for pulse-coder-engine (no .d.ts generated in dist yet).
// Remove this file once the engine's tsup DTS build is fixed.
declare module 'pulse-coder-engine' {
  export const GenerateImageTool: any;

  export class Engine {
    constructor(options?: any);
    initialize(): Promise<void>;
    run(context: any, options?: any): Promise<string>;
    getTools(): Record<string, any>;
    getService<T>(name: string): T | undefined;
    compactContext(context: any, options?: any): Promise<any>;
  }
}
