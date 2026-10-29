import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { commitCellChanges } from "../src/organism/history";

const tempDirs: string[] = [];

async function mkTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cell-history-"));
	tempDirs.push(dir);
	return dir;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function initRepo(dir: string): Promise<void> {
	await runGit(dir, ["init", "-q", "-b", "main"]);
	await runGit(dir, ["config", "user.email", "test@example.com"]);
	await runGit(dir, ["config", "user.name", "Test"]);
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await removeWithRetries(dir);
});

describe("cell history", () => {
	it("commits cell changes with the session id when the cells folder is its own repo", async () => {
		const cellsDir = await mkTempDir();
		await initRepo(cellsDir);
		await Bun.write(path.join(cellsDir, "greet.js"), "function greet() {}");

		const sha = await commitCellChanges(cellsDir, "session-123");
		expect(sha).toBeString();
		const details = await vcs.requireGit(cellsDir).commitDetails("HEAD");
		expect(details.message).toContain("cells: update greet");
		expect(details.message).toContain("Session: session-123");

		// Nothing pending: no empty commit.
		expect(await commitCellChanges(cellsDir, "session-123")).toBeUndefined();

		await fs.rm(path.join(cellsDir, "greet.js"));
		expect(await commitCellChanges(cellsDir, undefined)).toBeString();
		expect(await vcs.requireGit(cellsDir).lsFiles(false, false)).toEqual([]);
	});

	it("never commits into a parent repository or a plain folder", async () => {
		const plain = await mkTempDir();
		await Bun.write(path.join(plain, "greet.js"), "function greet() {}");
		expect(await commitCellChanges(plain, "s")).toBeUndefined();

		// e.g. ~/.omp kept inside a dotfiles repo
		const dotfiles = await mkTempDir();
		await initRepo(dotfiles);
		const nested = path.join(dotfiles, "agent", "cells");
		await Bun.write(path.join(nested, "greet.js"), "function greet() {}");
		expect(await commitCellChanges(nested, "s")).toBeUndefined();
		expect(await vcs.requireGit(dotfiles).headSha()).toBeNull();
	});
});
