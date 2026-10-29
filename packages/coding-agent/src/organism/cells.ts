import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getAgentDir, getProjectAgentDir, prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../eval/preludes";
import organismGuidance from "../prompts/system/organism.md" with { type: "text" };
import cellsDocumentation from "../prompts/tools/cells.md" with { type: "text" };
import { createCellHistory } from "./history";
import type { ToolSession } from "../tools";
import { cfgToolsOrganism } from "../tools/settings";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import editSeed from "./seeds/edit.js" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import searchSeed from "./seeds/search.js" with { type: "text" };

/** Eval language a cell loads into, from its file extension. */
export type CellLanguage = "js" | "py";

/** A model-written helper loaded into its language's eval kernel as `cells.<name>`. */
export interface Cell {
	name: string;
	language: CellLanguage;
	/** First leading comment line (`//` or `#`), shown in the index. */
	summary: string | undefined;
	source: string;
	/** Path on disk, or `seed:<name>` for a bundled seed. */
	file: string;
}

/** Bundled starter cells, lowest precedence: any saved cell of the same name replaces one. */
export const SEED_CELLS: readonly Cell[] = Object.entries({
	edit: editSeed as string,
	search: searchSeed as string,
}).map(([name, source]) => ({
	name,
	language: "js",
	summary: cellSummary(source, "js"),
	source,
	file: `seed:${name}`,
}));

/** Directories cells load from, lowest precedence first. */
export interface CellDirs {
	userDir: string;
	projectDir: string;
}

/** Valid `cells.<name>` identifiers per language. */
const CELL_NAME: Record<CellLanguage, RegExp> = { js: /^[A-Za-z_$][\w$]*$/, py: /^[A-Za-z_]\w*$/ };
const CELL_EXTENSION = /\.(js|py)$/;
/** `cells.failed` holds load errors, so no cell may claim the name. */
const RESERVED_CELL_NAMES = new Set(["failed"]);

export function resolveCellDirs(cwd: string): CellDirs {
	return {
		userDir: path.join(getAgentDir(), "cells"),
		projectDir: path.join(getProjectAgentDir(cwd), "cells"),
	};
}

function cellSummary(source: string, language: CellLanguage): string | undefined {
	const first = (language === "js" ? /^\s*\/\/(.*)/ : /^\s*#(?!!)(.*)/).exec(source);
	const summary = first?.[1]?.trim();
	return summary || undefined;
}

/**
 * Parsed cells keyed by path, reused while mtime and size match. Cell sources
 * are rebuilt on every eval run, so only changed files are read again.
 */
const cellFileCache = new Map<string, { mtimeMs: number; size: number; cell: Cell }>();

/** Read one directory's cells; a missing directory has none. */
function readCellDir(dir: string): Cell[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const cells: Cell[] = [];
	for (const entry of entries.sort()) {
		const extension = CELL_EXTENSION.exec(entry);
		if (!extension) continue;
		const language = extension[1] as CellLanguage;
		const name = entry.slice(0, -3);
		if (!CELL_NAME[language].test(name) || RESERVED_CELL_NAMES.has(name)) continue;
		const file = path.join(dir, entry);
		try {
			const stat = fs.statSync(file);
			const cached = cellFileCache.get(file);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				cells.push(cached.cell);
				continue;
			}
			const source = fs.readFileSync(file, "utf8");
			const cell: Cell = { name, language, summary: cellSummary(source, language), source, file };
			cellFileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, cell });
			cells.push(cell);
		} catch {
			cellFileCache.delete(file);
		}
	}
	return cells;
}

/**
 * Load every cell: seeds, then user cells, then project cells, each replacing
 * an earlier cell of the same name.
 *
 * Synchronous because a prelude's JavaScript source is read synchronously on
 * every eval run; that per-run read is what makes a freshly written cell
 * available on the next call without a restart.
 */
export function loadCells(dirs: CellDirs, seeds: readonly Cell[] = SEED_CELLS): Cell[] {
	// Each language has its own `cells` namespace, so `edit.js` and `edit.py` coexist.
	const byKey = new Map<string, Cell>();
	for (const cell of [...seeds, ...readCellDir(dirs.userDir), ...readCellDir(dirs.projectDir)]) {
		byKey.set(`${cell.language}\0${cell.name}`, cell);
	}
	return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

/**
 * JavaScript that installs the `cells` global. Each cell body runs in its own
 * function scope so `const` declarations never collide across reloads, and a
 * cell that throws is recorded in `cells.failed` instead of breaking eval.
 */
export function cellsJavascript(cells: readonly Cell[]): string {
	const defines = cells
		.filter(cell => cell.language === "js")
		.map(cell => `\tdefine(${JSON.stringify(cell.name)}, ${JSON.stringify(cell.source)});`)
		.join("\n");
	return `{
	const cells = {};
	const failed = {};
	const define = (name, source) => {
		try {
			cells[name] = new Function(source + "\\n;return " + name + ";")();
		} catch (error) {
			failed[name] = error instanceof Error ? error.message : String(error);
		}
	};
${defines}
	Object.defineProperty(cells, "failed", { value: Object.freeze(failed), enumerable: false });
	globalThis.cells = cells;
	globalThis.toolInfo = async name => {
		if (name !== undefined && typeof name !== "string") throw new TypeError("toolInfo() expects a tool name or nothing");
		const response = await globalThis.__omp_prelude__("cells", name === undefined ? {} : { name });
		return response && typeof response === "object" ? response.details : undefined;
	};
}`;
}

/**
 * Python that installs `cells` and `toolInfo` in the Python kernel. Each cell
 * module runs in its own copy of the kernel globals, so it sees every eval
 * helper without leaking its own top-level names; a cell that raises is
 * recorded in `cells.failed` instead of breaking eval.
 */
export function cellsPython(cells: readonly Cell[]): string {
	// JSON string literals are valid Python string literals.
	const entries = cells
		.filter(cell => cell.language === "py")
		.map(cell => `        (${JSON.stringify(cell.name)}, ${JSON.stringify(cell.source)}),`)
		.join("\n");
	return `def _omp_make_cells():
    import types
    cells = types.SimpleNamespace()
    failed = {}
    base = dict(globals())
    for name, source in [
${entries}
    ]:
        namespace = dict(base)
        namespace["__name__"] = "cell_" + name
        try:
            exec(compile(source, "<cell " + name + ">", "exec"), namespace)
            if name not in namespace:
                raise NameError("cell must define " + name)
            setattr(cells, name, namespace[name])
        except Exception as error:
            failed[name] = type(error).__name__ + ": " + str(error)
    cells.failed = failed
    return cells


cells = _omp_make_cells()
del _omp_make_cells


async def toolInfo(name=None):
    if name is not None and not isinstance(name, str):
        raise TypeError("toolInfo() expects a tool name or nothing")
    response = await _omp_prelude("cells", {} if name is None else {"name": name})
    return response.get("details") if isinstance(response, dict) else None
`;
}

/** One eval-hosted tool as `toolInfo()` reports it. */
export interface HostedToolInfo {
	name: string;
	/** First description line. */
	summary: string;
	description?: string;
	/** JSON schema of the `args` object `tool.<name>(args)` takes. */
	parameters?: Record<string, unknown>;
}

function hostedToolInfo(tool: AgentTool, full: boolean): HostedToolInfo {
	const summary = tool.description.trim().split("\n", 1)[0] ?? "";
	if (!full) return { name: tool.name, summary };
	return { name: tool.name, summary, description: tool.description, parameters: toolWireSchema(tool) };
}

function hostedToolsResult(tools: readonly AgentTool[], name: string | undefined) {
	if (name === undefined) {
		const list = tools.map(tool => hostedToolInfo(tool, false));
		const text = list.map(info => `${info.name}: ${info.summary}`).join("\n") || "No hosted tools";
		return { content: [{ type: "text" as const, text }], details: list };
	}
	const tool = tools.find(candidate => candidate.name === name);
	if (!tool) throw new ToolError(`No hosted tool named ${name}; call toolInfo() for the list`);
	const info = hostedToolInfo(tool, true);
	return { content: [{ type: "text" as const, text: JSON.stringify(info.parameters) }], details: info };
}

/**
 * Organism-mode prelude: the model's saved cells, re-read from disk on every
 * eval run, `toolInfo()` for discovering eval-hosted (MCP, extension) tools, and
 * the system-prompt block that tells it eval is its only tool.
 */
export function createCellsPrelude(
	session: ToolSession,
	hostedTools: () => readonly AgentTool[] = () => [],
): EvalPreludeDefinition {
	const dirs = () => resolveCellDirs(session.cwd);
	const history = createCellHistory(
		() => dirs().userDir,
		() => session.getSessionId?.(),
	);
	// Fingerprint of the user folder's cells as of the last eval run; a change
	// (written by the model, or by hand) schedules a history commit.
	let userCellsFingerprint: string | undefined;
	const trackUserCells = () => {
		// Read the folder itself: a project cell of the same name hides a user cell from the merged set.
		const fingerprint = Bun.hash(
			readCellDir(dirs().userDir)
				.map(cell => `${cell.file}\0${cell.source}`)
				.join("\0"),
		).toString(16);
		if (fingerprint === userCellsFingerprint) return;
		userCellsFingerprint = fingerprint;
		void history.schedule();
	};
	const documentation = (cells: readonly Cell[]) =>
		prompt.render(cellsDocumentation, {
			...dirs(),
			cells: cells.map(({ name, language, summary }) => ({ name, py: language === "py", summary })),
		});
	return {
		name: "cells",
		get documentation() {
			return documentation(loadCells(dirs()));
		},
		get javascript() {
			trackUserCells();
			return cellsJavascript(loadCells(dirs()));
		},
		get python() {
			trackUserCells();
			return cellsPython(loadCells(dirs()));
		},
		exports: ["cells", "toolInfo"],
		approval: "read",
		get guidance() {
			const cells = loadCells(dirs());
			return prompt.render(organismGuidance, {
				contract: documentation(cells),
				cells,
				hosted: hostedTools().map(tool => hostedToolInfo(tool, false)),
			});
		},
		enabled: () => cfgToolsOrganism.get(session.settings) === true,
		invoke: async parameters => {
			const name =
				parameters !== null && typeof parameters === "object" && "name" in parameters
					? String(parameters.name)
					: undefined;
			return hostedToolsResult(hostedTools(), name);
		},
	};
}
