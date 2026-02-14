import * as vscode from 'vscode';
import type { ForestContext } from '../context';
import { exec } from '../utils/exec';
import { generateText } from '../utils/ai';

export async function commit(ctx: ForestContext): Promise<void> {
  if (!ctx.currentTree) {
    vscode.window.showErrorMessage('Commit must be run from a tree window.');
    return;
  }

  const { stdout: diff } = await exec('git', ['diff', '--cached'], { cwd: ctx.currentTree.path });
  if (!diff.trim()) {
    vscode.window.showWarningMessage('No staged changes. Stage files with git add first.');
    return;
  }

  let message: string;
  try {
    message = await generateText(
      ctx.config,
      'Generate a concise git commit message (1 line, no quotes) for this diff:',
      diff.slice(0, 8000),
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(`AI error: ${e.message}`);
    return;
  }

  const edited = await vscode.window.showInputBox({
    prompt: 'Commit message',
    value: message,
    placeHolder: 'Enter commit message',
  });
  if (!edited) return;

  try {
    await exec('git', ['commit', '-m', edited], { cwd: ctx.currentTree.path });
    vscode.window.showInformationMessage('Committed.');
  } catch (e: any) {
    vscode.window.showErrorMessage(`Commit failed: ${e.message}`);
  }
}
