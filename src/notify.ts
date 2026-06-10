import * as vscode from 'vscode';

const auto = (title: string, ms: number) => {
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    () => new Promise<void>(r => setTimeout(r, ms)),
  );
};

export const notify = {
  info: (msg: string) => auto(msg, 4000),
  // showWarningMessage renders the $(warning) codicon in the message —
  // withProgress titles don't render markdown/codicons, so we previously
  // showed users the literal text "$(warning) …".
  warn: (msg: string) => { vscode.window.showWarningMessage(msg); },
  error: (msg: string) => { vscode.window.showErrorMessage(msg); },
};
