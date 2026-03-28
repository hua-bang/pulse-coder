import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export interface ArtifactStore {
  write(runId: string, nodeId: string, role: string, content: string): Promise<string>;
  getPath(runId: string, nodeId: string): string;
  cleanup?(runId: string): Promise<void>;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(private baseDir: string = '.pulse-coder/agent-teams') {}

  getPath(runId: string, nodeId: string): string {
    return join(this.baseDir, runId, `${nodeId}.md`);
  }

  async write(runId: string, nodeId: string, role: string, content: string): Promise<string> {
    const dir = join(this.baseDir, runId);
    await mkdir(dir, { recursive: true });
    const filePath = this.getPath(runId, nodeId);
    const body = `# [${role}] ${nodeId}\n\n${content}`;
    await writeFile(filePath, body, 'utf-8');
    return filePath;
  }
}
