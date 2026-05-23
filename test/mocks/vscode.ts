type Listener<T> = (event: T) => unknown;

class EventEmitter<T> {
	private listeners = new Set<Listener<T>>();

	readonly event = (listener: Listener<T>) => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	fire(event: T): void {
		for (const listener of this.listeners) listener(event);
	}

	dispose(): void {
		this.listeners.clear();
	}
}

const disposable = () => ({ dispose() {} });
const outputChannel = () => ({
	appendLine() {},
	show() {},
	dispose() {},
});

export const ProgressLocation = { Notification: 15 };
export const workspace: any = {
	workspaceFolders: undefined,
	createFileSystemWatcher: () => ({
		onDidChange() { return disposable(); },
		onDidCreate() { return disposable(); },
		onDidDelete() { return disposable(); },
		dispose() {},
	}),
	openTextDocument: async () => ({}),
};
export const window: any = {
	showQuickPick: async () => undefined,
	showInformationMessage: async () => undefined,
	showWarningMessage: async () => undefined,
	showErrorMessage: async () => undefined,
	withProgress: async (_options: unknown, task: (progress: { report(value: { message?: string }): void }) => unknown) =>
		task({ report() {} }),
	createOutputChannel: outputChannel,
	registerTreeDataProvider: disposable,
	registerWebviewViewProvider: disposable,
	onDidChangeWindowState: () => disposable(),
	createStatusBarItem: () => ({ ...disposable(), show() {}, hide() {} }),
	showTextDocument: async () => undefined,
};
export const commands = {
	executeCommand: async () => undefined,
	registerCommand: () => disposable(),
};
export const env = {
	clipboard: {
		writeText: async () => undefined,
	},
};
export class RelativePattern {
	constructor(
		public base: string,
		public pattern: string,
	) {}
}
export const Uri = {
	file: (fsPath: string) => ({ fsPath, path: fsPath, scheme: "file" }),
};

export function __resetVscodeMock(): void {
	workspace.workspaceFolders = undefined;
}

export { EventEmitter };
