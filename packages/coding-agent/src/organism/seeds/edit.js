// Replace exact text in a file: await cells.edit(path, oldText, newText, { all }) → { path, replaced }
// Throws unless oldText occurs exactly once; pass { all: true } to replace every occurrence. newText is literal ($ is not special).
async function edit(path, oldText, newText, options = {}) {
	if (typeof oldText !== "string" || oldText.length === 0)
		throw new TypeError("edit: oldText must be a non-empty string");
	if (typeof newText !== "string") throw new TypeError("edit: newText must be a string");
	const text = await read(path);
	const count = text.split(oldText).length - 1;
	if (count === 0) throw new Error(`edit: text not found in ${path}`);
	if (count > 1 && !options.all) {
		throw new Error(`edit: text occurs ${count} times in ${path}; include more context or pass { all: true }`);
	}
	const next = options.all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
	await write(path, next);
	return { path, replaced: options.all ? count : 1 };
}
