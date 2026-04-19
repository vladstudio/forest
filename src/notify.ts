import * as vscode from 'vscode';

// VS Code has no native auto-dismiss API for info/warn messages.
// We abuse withProgress to get a timed notification. The spinner is an
// acceptable trade-off for auto-dismiss behavior.
const auto = (title: string, ms: number) =>
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    () => new Promise<void>(r => setTimeout(r, ms)),
  );

export const notify = {
  info: (msg: string) => auto(msg, 4000),
  warn: (msg: string) => auto(`$(warning) ${msg}`, 5000),
  error: (msg: string) => { vscode.window.showErrorMessage(msg); },
};
