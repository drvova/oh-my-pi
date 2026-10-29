// Search file contents by regex: await cells.search(pattern, { glob, path, limit, ignoreCase }) → [{ file, line, text }]
// glob defaults to "**/*", path to the cwd, limit to 100 matches. Skips node_modules, .git, binary files and files over 1 MB.
async function search(pattern, options = {}) {
	const { glob = "**/*", path = ".", limit = 100, ignoreCase = false } = options;
	const regex = new RegExp(pattern, ignoreCase ? "i" : "");
	// Resolve like read()/write(): relative to the session cwd, not the worker's process cwd.
	const base = globalThis.__omp_session__?.cwd ?? process.cwd();
	const root = /^([A-Za-z]:[\\/]|[\\/])/.test(path) ? path : `${base}/${path}`;
	const matches = [];
	for await (const relative of new Bun.Glob(glob).scan({ cwd: root, onlyFiles: true })) {
		if (/(^|\/)(node_modules|\.git)(\/|$)/.test(relative)) continue;
		const file = path === "." ? relative : `${path.replace(/\/$/, "")}/${relative}`;
		const handle = Bun.file(`${root}/${relative}`);
		if (handle.size > 1_000_000) continue;
		const text = await handle.text();
		if (text.includes("\0")) continue;
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (!regex.test(lines[index])) continue;
			matches.push({ file, line: index + 1, text: lines[index].slice(0, 300) });
			if (matches.length >= limit) return matches;
		}
	}
	return matches;
}
