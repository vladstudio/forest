import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			vscode: fileURLToPath(new URL("./test/mocks/vscode.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		setupFiles: ["./test/setup.ts"],
	},
});
