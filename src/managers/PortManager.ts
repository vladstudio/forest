import type { ForestConfig } from '../config';
import type { StateManager } from '../state';

export class PortManager {
  constructor(private config: ForestConfig, private stateManager: StateManager) {}

  async allocate(repoPath: string): Promise<number> {
    const state = await this.stateManager.load();
    const usedBases = new Set(this.stateManager.getTreesForRepo(state, repoPath).map(t => t.portBase));
    const [start, end] = this.config.ports.baseRange;
    const step = this.getMaxOffset() + 1;
    for (let base = start; base + step - 1 <= end; base += step) {
      if (!usedBases.has(base)) return base;
    }
    throw new Error(`No available ports in range [${start}, ${end}]. Fell some trees to free ports.`);
  }

  private getMaxOffset(): number {
    return Math.max(...Object.values(this.config.ports.mapping).map(v => parseInt(v.replace('+', '')) || 0), 0);
  }

  resolvePorts(base: number): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, off] of Object.entries(this.config.ports.mapping)) {
      result[name] = base + (parseInt(off.replace('+', '')) || 0);
    }
    return result;
  }
}
