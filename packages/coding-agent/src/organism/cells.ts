import * as fs from "node:fs";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getAgentDir, getProjectAgentDir, prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../eval/preludes";
import organismGuidance from "../prompts/system/organism.md" with { type: "text" };
import cellsDocumentation from "../prompts/tools/cells.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { cfgToolsOrganism } from "../tools/settings";

/** A model-written helper loaded into JavaScript eval as `cells.<name>`. */
export interface Cell {
	name: string;
	/** First leading `//` comment line, shown in the index. */
	summary: string | undefined;
	source: string;
	file: string;
}

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
		let source: string;
		try {
			source = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		cells.push({ name, summary: cellSummary(source), source, file });
	}
	return cells;
}

/**
 * Load every cell, project cells replacing user cells of the same name.
 *
 * Synchronous because a prelude's JavaScript source is read synchronously on
 * every eval run; that per-run read is what makes a freshly written cell
 * available on the next call without a restart.
 */
export function loadCells(dirs: CellDirs): Cell[] {
	const byName = new Map<string, Cell>();
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
}`;
}

/**
 * Organism-mode prelude: the model's saved cells, re-read from disk on every
 * eval run, plus the system-prompt block that tells it eval is its only tool.
 */
export function createCellsPrelude(session: ToolSession): EvalPreludeDefinition {
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
		exports: ["cells"],
		get guidance() {
			const cells = loadCells(dirs());
			return prompt.render(organismGuidance, { contract: documentation(cells), cells });
		},
		enabled: () => cfgToolsOrganism.get(session.settings) === true,
		invoke: async () => {
			throw new ToolError("cells has no host calls; call cells.<name>(…) directly");
		},
	};
}
