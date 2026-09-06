// schema.sql is canonical (CLAUDE.md, §19) and loaded at runtime, so it has to
// reach dist/ alongside the compiled db.js. tsc only emits .ts.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist/storage", { recursive: true });
copyFileSync("src/storage/schema.sql", "dist/storage/schema.sql");
