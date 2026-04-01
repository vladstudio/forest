import * as vscode from 'vscode';

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
