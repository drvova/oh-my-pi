import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getAgentDir, getProjectAgentDir, prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../eval/preludes";
import organismGuidance from "../prompts/system/organism.md" with { type: "text" };
import cellsDocumentation from "../prompts/tools/cells.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { cfgToolsOrganism } from "../tools/settings";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import editSeed from "./seeds/edit.js" with { type: "text" };
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import searchSeed from "./seeds/search.js" with { type: "text" };

/** A model-written helper loaded into JavaScript eval as `cells.<name>`. */
export interface Cell {
	name: string;
	/** First leading `//` comment line, shown in the index. */
	summary: string | undefined;
	source: string;
	/** Path on disk, or `seed:<name>` for a bundled seed. */
	file: string;
}

/** Bundled starter cells, lowest precedence: any saved cell of the same name replaces one. */
export const SEED_CELLS: readonly Cell[] = Object.entries({
	edit: editSeed as string,
	search: searchSeed as string,
}).map(([name, source]) => ({ name, summary: cellSummary(source), source, file: `seed:${name}` }));

/** Directories cells load from, lowest precedence first. */
export interface CellDirs {
	userDir: string;
	projectDir: string;
}

const CELL_NAME = /^[A-Za-z_$][\w$]*$/;
/** `cells.failed` holds load errors, so no cell may claim the name. */
const RESERVED_CELL_NAMES = new Set(["failed"]);

export function resolveCellDirs(cwd: string): CellDirs {
	return {
		userDir: path.join(getAgentDir(), "cells"),
		projectDir: path.join(getProjectAgentDir(cwd), "cells"),
	};
}

function cellSummary(source: string): string | undefined {
	const first = /^\s*\/\/(.*)/.exec(source);
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
		if (!entry.endsWith(".js")) continue;
		const name = entry.slice(0, -3);
		if (!CELL_NAME.test(name) || RESERVED_CELL_NAMES.has(name)) continue;
		const file = path.join(dir, entry);
		try {
			const stat = fs.statSync(file);
			const cached = cellFileCache.get(file);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				cells.push(cached.cell);
				continue;
			}
			const source = fs.readFileSync(file, "utf8");
			const cell = { name, summary: cellSummary(source), source, file };
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
	const byName = new Map<string, Cell>();
	for (const cell of seeds) byName.set(cell.name, cell);
	for (const cell of readCellDir(dirs.userDir)) byName.set(cell.name, cell);
	for (const cell of readCellDir(dirs.projectDir)) byName.set(cell.name, cell);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * JavaScript that installs the `cells` global. Each cell body runs in its own
 * function scope so `const` declarations never collide across reloads, and a
 * cell that throws is recorded in `cells.failed` instead of breaking eval.
 */
export function cellsJavascript(cells: readonly Cell[]): string {
	const defines = cells
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
	const documentation = (cells: readonly Cell[]) =>
		prompt.render(cellsDocumentation, {
			...dirs(),
			cells: cells.map(({ name, summary }) => ({ name, summary })),
		});
	return {
		name: "cells",
		get documentation() {
			return documentation(loadCells(dirs()));
		},
		get javascript() {
			return cellsJavascript(loadCells(dirs()));
		},
		python: "",
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
