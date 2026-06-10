import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getHostWorkspacePath, resolveMainRepo } from "./context";
import { notify } from "./notify";
import { repoHash, safeRelativePath } from "./utils/fs";

interface ShortcutBase {
	name: string;
	onNewTree?: boolean;
}
interface TerminalShortcut extends ShortcutBase {
	type: "terminal";
	command?: string;
	env?: Record<string, string>;
}
interface BrowserShortcut extends ShortcutBase {
	type: "browser";
	url: string;
	browser?: "integrated" | "external" | string;
}
export type ShortcutConfig = TerminalShortcut | BrowserShortcut;

const SHORTCUT_CATEGORIES = {
	cli: "terminal" as const,
	web: "browser" as const,
};

export interface ShortcutsConfig {
	cli: TerminalShortcut[];
	web: BrowserShortcut[];
}

/** Flattens all shortcut categories into a single array. */
export function allShortcuts(s: ShortcutsConfig): ShortcutConfig[] {
	return [...s.cli, ...s.web];
}

export interface ForestConfig {
	version: number;
	copy: string[];
	symlink: string[];
	shortcuts: ShortcutsConfig;
	linear: {
		enabled: boolean;
		apiKey?: string;
		teams?: string[];
		showTodos?: boolean;
		statuses: {
			issueList: string[];
			onNew: string;
			onShip: string;
			onCleanup: string;
			onCancel: string;
		};
	};
	github: { enabled: boolean };
	ai?: boolean;
	branchFormat: string;
	branchNamePrefix: string;
	baseBranch: string;
	maxTrees: number;
	browser: string[];
	terminal: string[];
}

const DEFAULTS: Partial<ForestConfig> = {
	version: 1,
	copy: [],
	symlink: [],
	shortcuts: { cli: [], web: [] },
	linear: {
		enabled: false,
		statuses: {
			issueList: ["triage", "backlog", "unstarted", "started"],
			onNew: "started",
			onShip: "in review",
			onCleanup: "completed",
			onCancel: "canceled",
		},
	},
	github: { enabled: true },
	branchFormat: "${ticketId}-${slug}",
	branchNamePrefix: "",
	baseBranch: "main",
	maxTrees: 10,
	browser: ["integrated"],
	terminal: ["integrated"],
};

export async function loadConfig(): Promise<ForestConfig | null> {
	const wsPath = getHostWorkspacePath();
	if (!wsPath) return null;

	const repoRoot = resolveMainRepo(wsPath);
	const configPath = path.join(repoRoot, ".forest", "config.json");
	if (!fs.existsSync(configPath)) return null;

	let config: any;
	try {
		config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	} catch (e) {
		notify.error(`Forest config is invalid: ${e}`);
		return null;
	}

	// Merge: defaults → config → local
	let merged: any = mergeConfig(DEFAULTS, config);
	const localPath = path.join(repoRoot, ".forest", "local.json");
	if (fs.existsSync(localPath)) {
		try {
			const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
			merged = mergeConfig(merged, local);
		} catch {
			notify.warn("Forest: local.json has syntax errors, ignoring overrides.");
		}
	}

	// Auto-enable Linear when API key is present or teams are configured
	if (merged.linear?.apiKey || merged.linear?.teams?.length) {
		merged.linear.enabled = true;
	}

	// Normalize browser/terminal to arrays
	if (typeof merged.browser === "string") merged.browser = [merged.browser];
	if (typeof merged.terminal === "string") merged.terminal = [merged.terminal];

	// Inject shortcut types
	const s = merged.shortcuts || {};
	merged.shortcuts = Object.fromEntries(
		(
			Object.keys(SHORTCUT_CATEGORIES) as (keyof typeof SHORTCUT_CATEGORIES)[]
		).map((key) => [
			key,
			(s[key] || []).map((x: any) => ({
				...x,
				type: SHORTCUT_CATEGORIES[key],
			})),
		]),
	) as ShortcutsConfig;

	// Normalize baseBranch: strip any origin/ prefix — callers prepend when needed
	merged.baseBranch = (merged.baseBranch?.trim() || "main").replace(
		/^origin\//,
		"",
	);

	// Normalize github: accept boolean shorthand
	if (typeof merged.github === "boolean") {
		merged.github = { enabled: merged.github };
	}
	try {
		validateConfig(repoRoot, merged);
	} catch (e: any) {
		notify.error(`Forest config is invalid: ${e.message}`);
		return null;
	}

	return merged as ForestConfig;
}

/** Returns ~/.forest/trees/<repoName>[-<hash>]. Uses old unhashed dir if it exists for backwards compat. */
const treesDirCache = new Map<string, string>();
export function clearTreesDirCache(): void { treesDirCache.clear(); }
export function getTreesDir(repoPath: string): string {
	let dir = treesDirCache.get(repoPath);
	if (dir) return dir;
	const base = path.basename(repoPath);
	const oldDir = path.join(os.homedir(), ".forest", "trees", base);
	dir = fs.existsSync(oldDir)
		? oldDir
		: path.join(
				os.homedir(),
				".forest",
				"trees",
				`${base}-${repoHash(repoPath)}`,
			);
	treesDirCache.set(repoPath, dir);
	return dir;
}

/** Object fields merge, shortcuts merge by name, and other arrays intentionally replace.
 *  Note: `null` values in `local` are intentionally ignored — local.json can
 *  override a config.json setting with a new value, but cannot unset it. To
 *  drop a setting, set it to a safe empty value (e.g. `[]`, `""`, `0`). */
function mergeConfig(base: any, local: any): any {
	const result = { ...base };
	for (const key of Object.keys(local)) {
		if (key === "shortcuts") {
			result[key] = {};
			for (const sub of Object.keys(
				SHORTCUT_CATEGORIES,
			) as (keyof typeof SHORTCUT_CATEGORIES)[]) {
				const arr = [...(base[key]?.[sub] || [])];
				for (const item of local[key]?.[sub] || []) {
					const idx = arr.findIndex((b: any) => b.name === item.name);
					if (idx >= 0) arr[idx] = { ...arr[idx], ...item };
					else arr.push(item);
				}
				result[key][sub] = arr;
			}
		} else if (
			typeof local[key] === "object" &&
			!Array.isArray(local[key]) &&
			local[key] !== null
		) {
			result[key] = mergeConfig(base[key] || {}, local[key]);
		} else if (local[key] !== null) {
			result[key] = local[key];
		}
	}
	return result;
}

function validateConfig(repoRoot: string, config: ForestConfig): void {
	if (typeof config.version !== "number") throw new Error("version must be a number");
	for (const key of ["copy", "symlink", "browser", "terminal"] as const) {
		if (!Array.isArray(config[key])) throw new Error(`${key} must be an array`);
	}
	for (const value of [...config.copy, ...config.symlink]) {
		safeRelativePath(repoRoot, value, "copy/symlink path");
	}
	for (const group of ["cli", "web"] as const) {
		if (!Array.isArray(config.shortcuts[group])) throw new Error(`shortcuts.${group} must be an array`);
	}
}
