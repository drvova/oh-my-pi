Your own tooling: JavaScript cells saved on disk and loaded into every JS eval session as `cells.<name>`.

<instruction>
- A cell is one file, `<name>.js`, in `{{userDir}}` (every project) or `{{projectDir}}` (this project only; wins on a name clash). `<name>` MUST be a JavaScript identifier.
- The file body runs as a function body and MUST define a binding called `<name>`, usually `async function <name>(…) { … }`. No top-level `await`, `import` or `export`; use `await import(…)` inside the function.
- Start the file with `//` comment lines: the first line is the summary shown in the index, the rest is usage.
- Cells see every eval global (`read`, `write`, `print`, `Bun`, `tool`, other `cells.*`).
- Save a cell with `await write("<dir>/<name>.js", source)`. The next eval call reloads it; no restart.
- `edit` and `search` ship as seeds. Save a cell with the same name to replace one.
- `cells` and `toolInfo` are reserved: NEVER declare a top-level variable with either name; it hides them for the rest of the session.
- Delete the file to forget a cell. A cell that fails to load is skipped and listed in `cells.failed` with its error.
</instruction>
{{#if cells.length}}

<index>
{{#each cells}}
- `cells.{{name}}`{{#if summary}}: {{summary}}{{/if}}
{{/each}}
</index>
{{/if}}
