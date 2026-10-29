import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type Cell, cellsJavascript, cellsPython, loadCells } from "../src/organism/cells";

/** Run the prelude source against an isolated global and return what it installed. */
function install(source: string): Record<string, unknown> & { failed: Record<string, string> } {
	const scope: Record<string, unknown> = {};
	new Function("globalThis", source)(scope);
	return scope.cells as Record<string, unknown> & { failed: Record<string, string> };
}

describe("organism cells", () => {
	it("layers seed < user < project cells, isolates broken cells, and reloads rewritten ones", async () => {
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

		const seed: Cell = {
			name: "greet",
			language: "js",
			summary: "Seed greet",
			source: "function greet() { return 'seed'; }",
			file: "seed:greet",
		};
		const cells = loadCells(dirs, [seed]);
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

		// A rewritten cell is picked up on the next load despite the read cache.
		await Bun.write(path.join(dirs.projectDir, "shout.js"), "// Louder\nconst shout = s => s.toUpperCase() + '!';");
		expect(loadCells(dirs, [seed]).find(cell => cell.name === "shout")?.summary).toBe("Louder");
	});

	// Python cells run in a real interpreter: the generated installer is the contract.
	it.skipIf(!Bun.which("python3"))("loads Python cells beside JavaScript ones and isolates failures", async () => {
		await using dir = await TempDir.create(path.join(os.tmpdir(), "omp-cells-py-"));
		const dirs = { userDir: dir.join("user"), projectDir: dir.join("project") };
		await Bun.write(path.join(dirs.userDir, "greet.js"), "// JS greet\nfunction greet() { return 'js'; }");
		await Bun.write(
			path.join(dirs.userDir, "greet.py"),
			"# Py greet\ndef greet(n):\n    return f'py {n} ' + helper_value\n",
		);
		await Bun.write(path.join(dirs.userDir, "missing.py"), "def other():\n    pass\n");
		await Bun.write(path.join(dirs.userDir, "boom.py"), "raise ValueError('bad cell')\n");

		const cells = loadCells(dirs, []);
		expect(cells.map(cell => [cell.name, cell.language, cell.summary])).toEqual([
			["boom", "py", undefined],
			["greet", "js", "JS greet"],
			["greet", "py", "Py greet"],
			["missing", "py", undefined],
		]);

		// Kernel globals the installer copies into each cell, plus the host bridge it binds.
		const script = `helper_value = "ok"\nasync def _omp_prelude(name, params):\n    return {"details": [name, params]}\n${cellsPython(cells)}
import asyncio, json
print(json.dumps({"greet": cells.greet("ada"), "failed": cells.failed, "info": asyncio.run(toolInfo("x"))}))`;
		const proc = Bun.spawn(["python3", "-I", "-c", script], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			greet: "py ada ok",
			failed: { boom: "ValueError: bad cell", missing: "NameError: cell must define missing" },
			info: ["cells", { name: "x" }],
		});
	});
});
