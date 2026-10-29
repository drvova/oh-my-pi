import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cellsJavascript, loadCells } from "../src/organism/cells";

/** Run the prelude source against an isolated global and return what it installed. */
function install(source: string): Record<string, unknown> & { failed: Record<string, string> } {
	const scope: Record<string, unknown> = {};
	new Function("globalThis", source)(scope);
	return scope.cells as Record<string, unknown> & { failed: Record<string, string> };
}

describe("organism cells", () => {
	it("loads saved cells, lets project cells override user cells, and isolates broken cells", async () => {
		await using dir = await TempDir.create(path.join(os.tmpdir(), "omp-cells-"));
		const dirs = { userDir: dir.join("user"), projectDir: dir.join("project") };
		await Bun.write(
			path.join(dirs.userDir, "greet.js"),
			"// Greets someone\nfunction greet(n) { return 'hi ' + n; }",
		);
		await Bun.write(path.join(dirs.userDir, "shout.js"), "const shout = s => 'user:' + s;");
		await Bun.write(path.join(dirs.projectDir, "shout.js"), "// Project shout\nconst shout = s => s.toUpperCase();");
		await Bun.write(path.join(dirs.userDir, "broken.js"), "function notBroken() {}");
		await Bun.write(path.join(dirs.userDir, "not-an-identifier.js"), "const x = 1;");

		const cells = loadCells(dirs);
		expect(cells.map(cell => [cell.name, cell.summary])).toEqual([
			["broken", undefined],
			["greet", "Greets someone"],
			["shout", "Project shout"],
		]);

		const installed = install(cellsJavascript(cells));
		expect((installed.greet as (n: string) => string)("ada")).toBe("hi ada");
		expect((installed.shout as (s: string) => string)("x")).toBe("X");
		expect(installed.broken).toBeUndefined();
		expect(installed.failed.broken).toContain("broken");
	});
});
