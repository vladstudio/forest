import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export async function init(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) { vscode.window.showErrorMessage('No workspace folder open.'); return; }

  const forestDir = path.join(ws.uri.fsPath, '.forest');
  const configPath = path.join(forestDir, 'config.json');

  if (fs.existsSync(configPath)) {
    const action = await vscode.window.showQuickPick(['Edit existing config', 'Cancel'], { placeHolder: 'Forest config already exists.' });
    if (action === 'Edit existing config') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configPath));
    }
    return;
  }

  // Detect package manager
  const root = ws.uri.fsPath;
  let pm = 'npm';
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) pm = 'bun';
  else if (fs.existsSync(path.join(root, 'yarn.lock'))) pm = 'yarn';
  else if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) pm = 'pnpm';

  // Setup command
  const setup = await vscode.window.showInputBox({
    prompt: 'Setup command (run after creating a tree)',
    value: `${pm} install`,
  });
  if (setup === undefined) return;

  // Files to copy
  const detectedFiles: string[] = [];
  for (const f of ['.env', '.env.local', '.envrc']) {
    if (fs.existsSync(path.join(root, f))) detectedFiles.push(f);
  }
  const copyPicks = detectedFiles.length > 0
    ? await vscode.window.showQuickPick(
        detectedFiles.map(f => ({ label: f, picked: true })),
        { canPickMany: true, placeHolder: 'Files to copy into new trees' },
      )
    : undefined;
  const copy = copyPicks?.map(p => p.label) ?? [];

  // Linear integration
  const linearPick = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Enable Linear integration?' });
  let linearTeam: string | undefined;
  if (linearPick === 'Yes') {
    linearTeam = await vscode.window.showInputBox({ prompt: 'Linear team name (optional)', placeHolder: 'e.g. ENG' }) || undefined;
  }

  // Trees directory
  const repoName = path.basename(root);
  const treesDir = await vscode.window.showInputBox({
    prompt: 'Trees directory',
    value: `~/forest-trees/${repoName}`,
  });
  if (!treesDir) return;

  // Build config
  const config: any = {
    version: 1,
    treesDir,
    setup: setup || undefined,
    copy,
    integrations: {
      linear: linearPick === 'Yes',
      github: true,
      ...(linearTeam ? { linearTeam } : {}),
    },
  };

  // Write files
  fs.mkdirSync(forestDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  fs.writeFileSync(
    path.join(forestDir, 'local.json.example'),
    JSON.stringify({ ai: { provider: 'gemini', apiKey: 'YOUR_KEY' } }, null, 2),
  );

  const reload = await vscode.window.showInformationMessage(
    'Forest config created! Reload window to activate.',
    'Reload',
  );
  if (reload === 'Reload') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
