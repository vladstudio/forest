import * as vscode from 'vscode';

export class FilterViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'forest.filter';
  private _onDidChangeFilter = new vscode.EventEmitter<string>();
  readonly onDidChangeFilter = this._onDidChangeFilter.event;
  filter = '';

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = /* html */ `<!DOCTYPE html>
<html><head><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { padding: 4px 8px; }
.wrap { position: relative; display: flex; }
input {
  width: 100%; padding: 3px 22px 3px 6px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px; font: inherit; outline: none;
}
input:focus { border-color: var(--vscode-focusBorder); }
input::placeholder { color: var(--vscode-input-placeholderForeground); }
.clear {
  position: absolute; right: 3px; top: 50%; transform: translateY(-50%);
  background: none; border: none; color: var(--vscode-input-foreground);
  cursor: pointer; font-size: 14px; line-height: 1; display: none; padding: 0 2px;
  opacity: .6;
}
.clear:hover { opacity: 1; }
input:not(:placeholder-shown) ~ .clear { display: block; }
</style></head><body>
<div class="wrap">
  <input id="f" type="text" placeholder="Filter…" spellcheck="false" />
  <button class="clear" id="c">\u00d7</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const f = document.getElementById('f');
const c = document.getElementById('c');
f.addEventListener('input', () => vscode.postMessage({ filter: f.value }));
c.addEventListener('click', () => { f.value = ''; f.dispatchEvent(new Event('input')); f.focus(); });
</script>
</body></html>`;
    view.webview.onDidReceiveMessage(msg => {
      if ('filter' in msg) {
        this.filter = msg.filter;
        this._onDidChangeFilter.fire(this.filter);
      }
    });
  }
}
