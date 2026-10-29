import type { Settings } from "../config/settings";
import { cfgToolsOrganism } from "../tools/settings";

/** Tools that stay top-level in organism mode: eval itself plus session protocol. */
const ORGANISM_TOP_LEVEL_TOOLS = new Set(["eval", "yield", "goal"]);

/**
 * Where a selected tool goes under the current settings.
 *
 * - `top`: presented to the model as usual (always, outside organism mode).
 * - `hosted`: enabled, so eval's `tool.<name>()` bridge can call it, but kept
 *   out of the top-level schema. Organism mode hosts MCP, extension and SDK tools.
 * - `dropped`: neither presented nor bridge-callable. Organism mode drops the
 *   built-ins that slip in as transports (e.g. the xd:// `write`), so the model
 *   builds that tooling itself.
 */
export function organismPlacement(settings: Settings, name: string, builtIn: boolean): "top" | "hosted" | "dropped" {
	if (!cfgToolsOrganism.get(settings) || ORGANISM_TOP_LEVEL_TOOLS.has(name)) return "top";
	return builtIn ? "dropped" : "hosted";
}
