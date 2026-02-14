import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { exec } from '../utils/exec';
import * as git from '../cli/git';
import * as gh from '../cli/gh';
import { generateText } from '../utils/ai';

export async function treeSummary(ctx: ForestContext): Promise<void> {
  if (!ctx.currentTree) return;
  const tree = ctx.currentTree;

  const config = ctx.config;

  const [log, behind, prInfo, statusResult] = await Promise.all([
    exec('git', ['log', '--oneline', '-3'], { cwd: tree.path }).then(r => r.stdout).catch(() => ''),
    git.commitsBehind(tree.path, config.baseBranch),
    gh.prStatus(tree.path).catch(() => null),
    exec('git', ['status', '--porcelain'], { cwd: tree.path }).then(r => r.stdout.split('\n').filter(Boolean).length).catch(() => 0),
  ]);

  const context = [
    `Branch: ${tree.branch}`,
    `Last 3 commits:\n${log}`,
    `Commits behind base: ${behind}`,
    prInfo ? `PR: ${prInfo.state}, review: ${prInfo.reviewDecision || 'none'}` : 'No PR',
    `Uncommitted files: ${statusResult}`,
  ].join('\n');

  try {
    const summary = await generateText(
      config,
      'Summarize this git tree status in exactly 1 short sentence. Be very concise.',
      context,
    );
    ctx.statusBarManager.setSummary(summary);
  } catch (e: any) {
    ctx.statusBarManager.setSummary(`Error: ${e.message}`);
  }
}
