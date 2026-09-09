import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("the static production entry and every module share one cache release", () => {
  const root = new URL("../", import.meta.url);
  const html = readFileSync(new URL("index.html", root), "utf8");
  const entry = new URL(html.match(/type="module" src="([^"]+)"/)[1], root);
  const version = entry.searchParams.get("v");
  assert.ok(version);
  const style = new URL(html.match(/href="([^"]+workspace\.css[^\"]*)"/)[1], root);
  assert.equal(style.searchParams.get("v"), version);
  const visited = new Set();
  const queue = [entry];
  while (queue.length) {
    const module = queue.pop();
    if (visited.has(module.href)) continue;
    visited.add(module.href);
    assert.equal(module.searchParams.get("v"), version, module.href);
    const source = readFileSync(fileURLToPath(module), "utf8");
    for (const match of source.matchAll(/from "(\.\/[^\"]+\.js[^\"]*)"/g)) queue.push(new URL(match[1], module));
  }
  assert.ok(visited.size > 5, "Walk the real transitive module graph, not only the entry");
});

test("every production element lookup exists after the workspace restructure", () => {
  const root = new URL("../", import.meta.url);
  const html = readFileSync(new URL("index.html", root), "utf8");
  const app = readFileSync(new URL("src/app.js", root), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, "DOM identifiers must remain unique");
  for (const match of app.matchAll(/getElementById\("([^"]+)"\)/g)) assert.ok(ids.includes(match[1]), `Missing ${match[1]}`);
});
