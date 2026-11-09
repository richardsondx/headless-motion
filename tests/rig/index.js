// Node 24 no longer expands a directory argument to `node --test`; it resolves it as a module.
// This entry lets `node --test tests/rig/` run every *.test.mjs file here.
import { readdirSync } from "node:fs";

const here = new URL("./", import.meta.url);
for (const name of readdirSync(here).sort()) {
  if (name.endsWith(".test.mjs")) await import(new URL(name, here));
}
