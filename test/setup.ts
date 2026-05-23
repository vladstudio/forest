import { afterEach } from "vitest";
import { __resetVscodeMock } from "./mocks/vscode";

afterEach(() => {
	__resetVscodeMock();
});
