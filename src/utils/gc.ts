import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ForestState } from "../state";
import { workspaceFilePath } from "../commands/shared";

type Log = (message: string) => void;

function removeStale(target: string, label: string, log: Log): void {
	try {
		fs.rmSync(target, { recursive: true, force: true });
		log(`Removed stale ${label}: ${target}`);
	} catch (e: any) {
		log(`Remove stale ${label} failed: ${e.message}`);
	}
}

function hasFiles(dir: string): boolean {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		const s = fs.lstatSync(p);
		if (!s.isDirectory() || hasFiles(p)) return true;
	}
	return false;
}

export function gcForestFiles(state: ForestState, log: Log): void {
	const trees = Object.values(state.trees);
	const treePaths = new Set(trees.flatMap((t) => t.path ? [t.path] : []));
	const workspacePaths = new Set(trees.map(workspaceFilePath));

	const workspaces = path.join(os.homedir(), ".forest", "workspaces");
	if (fs.existsSync(workspaces)) for (const name of fs.readdirSync(workspaces)) {
		if (!name.endsWith(".code-workspace")) continue;
		const file = path.join(workspaces, name);
		try {
			const treePath = JSON.parse(fs.readFileSync(file, "utf8"))?.folders?.[0]?.path;
			if (!treePath || !treePaths.has(treePath) || !fs.existsSync(treePath) || !workspacePaths.has(file)) {
				removeStale(file, "workspace", log);
			}
		} catch {
			removeStale(file, "workspace", log);
		}
	}

	const root = path.join(os.homedir(), ".forest", "trees");
	const buckets = new Set([...treePaths].map((p) => path.dirname(p)));
	if (fs.existsSync(root)) for (const name of fs.readdirSync(root)) {
		const dir = path.join(root, name);
		try {
			if (!buckets.has(dir) && fs.lstatSync(dir).isDirectory() && !hasFiles(dir)) {
				removeStale(dir, "tree bucket", log);
			}
		} catch {}
	}
}
