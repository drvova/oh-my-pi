import * as fs from "node:fs/promises";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Commit pending changes in the user cells folder when that folder is the root
 * of its own git repository. History is opt-in: running `git init` there turns
 * it on. A folder that merely sits inside another repository (a dotfiles repo
 * holding `~/.omp`) is never committed to.
 *
 * Returns the new commit sha, or `undefined` when there was nothing to commit.
 */
export async function commitCellChanges(
	userDir: string,
	sessionId: string | null | undefined,
): Promise<string | undefined> {
	const repo = vcs.git(userDir);
	if (!repo) return undefined;
	const [root, dir] = await Promise.all([fs.realpath(repo.primaryRoot()), fs.realpath(userDir)]);
	if (root !== dir) return undefined;
	const status = await repo.statusPorcelain({ untracked: "all", nulTerminated: true });
	const changed: string[] = [];
	const entries = status.split("\0");
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4) continue;
		// Renames and copies are followed by their source path as a separate entry.
		if (entry[0] === "R" || entry[0] === "C") index++;
		changed.push(entry.slice(3).replace(/\.js$/, ""));
	}
	if (changed.length === 0) return undefined;
	await repo.stageFiles([]);
	const subject = `cells: update ${changed.sort().join(", ")}`;
	return await repo.commitCreate(sessionId ? `${subject}\n\nSession: ${sessionId}` : subject, {});
}

/**
 * Serializes {@link commitCellChanges} per folder so overlapping eval runs never
 * race on the index; a failure is logged and never reaches the eval cell.
 */
export function createCellHistory(userDir: () => string, sessionId: () => string | null | undefined) {
	let queue: Promise<unknown> = Promise.resolve();
	return {
		schedule(): Promise<unknown> {
			queue = queue
				.then(() => commitCellChanges(userDir(), sessionId()))
				.catch(error => logger.warn("Failed to commit cell history", { error: String(error) }));
			return queue;
		},
	};
}
