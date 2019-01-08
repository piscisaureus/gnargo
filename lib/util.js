const { resolve } = require("path");
const { inspect } = require("util");
const { readdir } = require("./async");

const exeSuffix = process.platform === "win32" ? ".exe" : "";

// Helper to flatten arrays. Usage:
//   let array = array.reduce(...flat);
const flat = [(arr, item) => arr.concat(item), []];

async function* walkDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    e.path = resolve(dir, e.name);
    let subdirs = e.isDirectory() && walkDir(e.path);
    yield e;
    if (subdirs) yield* subdirs;
  }
}

async function searchDir(dir, matcher) {
  for await (const e of walkDir(dir)) {
    if (matcher(e)) return e;
  }
}

async function main(fn) {
  // Config options for easier debugging.
  inspect.defaultOptions.showHidden = false;
  inspect.defaultOptions.depth = null;
  Error.stackTraceLimit = 100;
  // Defer to next tick before invoking main().
  await null;
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => process.once("unhandledRejection", rej))
    ]);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

Object.assign(exports, {
  exeSuffix,
  flat,
  main,
  walkDir,
  searchDir
});
