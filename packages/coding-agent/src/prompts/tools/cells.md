Your own tooling: cells saved on disk and loaded into every eval session as `cells.<name>`.

<instruction>
- A cell is one file, `<name>.js` (JavaScript eval) or `<name>.py` (Python eval), in `{{userDir}}` (every project) or `{{projectDir}}` (this project only; wins on a name clash). `<name>` MUST be an identifier. Each language has its own `cells`.
- JavaScript: the file body runs as a function body and MUST define a binding called `<name>`, usually `async function <name>(…) { … }`. No top-level `await`, `import` or `export`; use `await import(…)` inside the function.
- Python: the file runs as a module once per load and MUST define `<name>` at top level, usually `def <name>(…):` or `async def <name>(…):`.
- Start the file with comment lines (`//` or `#`): the first line is the summary shown in the index, the rest is usage.
- Cells see every eval global (`read`, `write`, `print`, `tool`, other `cells.*`; JavaScript also `Bun`).
- Save a cell with `write("<dir>/<name>.<ext>", source)`. The next eval call reloads it; no restart.
- `edit` and `search` ship as JavaScript seeds. Save a cell with the same name to replace one.
- `cells` and `toolInfo` are reserved: NEVER assign a top-level variable with either name; it hides them for the rest of the session.
- History is opt-in: once `{{userDir}}` is its own git repository (`git init` there), every change to it is committed with the session id. Use `git log` and `git revert` there to inspect or undo a cell change.
- Delete the file to forget a cell. A cell that fails to load is skipped and listed in `cells.failed` with its error.
</instruction>
{{#if cells.length}}

<index>
{{#each cells}}
- `cells.{{name}}`{{#if py}} (Python){{/if}}{{#if summary}}: {{summary}}{{/if}}
{{/each}}
</index>
{{/if}}
