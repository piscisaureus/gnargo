"use strict";

const assert = require("assert");
const { resolve, basename, extname, dirname, relative } = require("path");
const { readFileSync, writeFileSync, readDirSync } = require("fs");
const { inspect } = require("util");
const { execFile, readFile, writeFile } = require("./lib/async");
const { searchDir, exeSuffix, flat, main } = require("./lib/util");

const WORK_DIR = process.argv[2] || `${__dirname}/work`;

main(async () => {
  const commands = JSON.parse(
    await readFile(`${WORK_DIR}/commands.json`, "utf8")
  );
  let { package_dirs, build_gn } = generate(commands);

  const package_dirs_json = JSON.stringify(package_dirs, null, 2);
  const package_dirs_json_path = resolve(WORK_DIR, "package_dirs.json");
  await writeFile(package_dirs_json_path, package_dirs_json);
  console.log(
    `Done generating package directory list. ${package_dirs_json_path}`
  );

  const boilerplate = await readFile(`${__dirname}/boilerplate.gn`, "utf8");
  build_gn = boilerplate.trim() + "\n\n" + build_gn;

  await writeFile(`${WORK_DIR}/BUILD_unformatted.gn`, build_gn);

  const build_gn_path = resolve(WORK_DIR, "BUILD.gn");
  await writeFile(build_gn_path, build_gn);
  await execFile(findGn(commands), ["format", build_gn_path], {
    stdio: "inherit"
  });
  console.log(`Done generating .gn file. ${build_gn_path}`);
});

async function findGn(commands) {
  let denoSourceDir = commands
    .filter(c => c.env.CARGO_PRIMARY_PACKAGE)
    .map(c => c.env.CARGO_MANIFEST_DIR)
    .shift();
  return (await searchDir(
    `${denoSourceDir}/buildtools`,
    f => f.isFile() && f.name === `gn${exeSuffix}`
  )).path;
}

function* mapIter(iter, fn) {
  for (const ii of iter) {
    yield fn(ii);
  }
}

function* filterIter(iter, fn) {
  for (const ii of iter) {
    if (fn(ii)) {
      yield ii;
    }
  }
}

function* flatIter(iter) {
  for (const ii of iter) {
    for (const jj of ii) {
      yield jj;
    }
  }
}

function* deepFlatIter(iter) {
  let isIter = iter =>
    iter && typeof iter !== "string" && Symbol.iterator in iter;
  if (!isIter(iter)) return yield iter;
  for (const ii of iter) {
    yield* deepFlatIter(ii);
  }
}

let primitives = new Set(["boolean", "number", "string", "symbol"]);
function toPrimitiveKey(value, debugInfo) {
  while (!primitives.has(typeof value) && value !== null) {
    if (value === undefined || typeof value.toPrimitiveKey !== "function") {
      //console.error(debugInfo);
      throw new Error(`Key error: ${value}`);
    }
    value = value.toPrimitiveKey();
  }
  return value;
}

class Node extends Set {
  constructor(...initializers) {
    super();
    let props = {};
    let items = undefined;
    for (let init of initializers) {
      if (typeof init === "function") {
        init = init.call(this, new Node(items, props));
        Object.assign(props, this);
      }
      if (init !== undefined) {
        props = { ...props, ...init };
        items = init[Symbol.iterator] ? init : items;
      }
    }
    Object.assign(this, props);
    if (items) {
      for (const item of items) {
        super.add(item);
      }
    }
  }

  write() {
    return this.writeInner();
  }
  writeInner() {
    return filterIter(
      deepFlatIter([
        this.writeHeader(),
        this.writeChildren(),
        this.writeFooter()
      ]),
      str => str != null
    );
  }
  writeHeader() {
    return `${this.constructor.name} {`;
  }
  writeChildren() {
    let num = 0;
    return [
      ...mapIter(
        deepFlatIter(
          mapIter(
            mapIter(this, ii => ii.write()),
            ii => (!num++ ? ii : [this.writeSpacing(ii), ii])
          )
        ),
        l => l != null && this.writeItem(l)
      )
    ];
  }
  writeSpacing(nextLine) {
    if (this.gnScope instanceof Root || /^\s*#/.test(nextLine)) {
      return [""];
    } else {
      return [];
    }
  }
  writeItem(str) {
    return `  ${str}`;
  }
  writeFooter() {
    return "}";
  }

  // Assign can add properties to both the container and the child nodes.
  assign(toItems, toSelf = toItems) {
    let args = [];
    if (toItems != null) {
      let mapFn = ii => new ii.constructor(ii, toItems);
      args.push(mapIter(this, mapFn));
    }
    if (toSelf != null) {
      args.push(toSelf);
    }
    return new this.constructor(this, ...args);
  }

  // Item only methods.
  add(...items) {
    return new this.constructor(this, flatIter([this, items]));
  }

  get clear() {}
  get delete() {}

  flat() {
    return new this.constructor(this, flatIter(this));
  }

  filter(fn) {
    return new this.constructor(this, filterIter(this, fn));
  }

  map(fn) {
    let mapFn =
      Node === fn || Node.isPrototypeOf(fn)
        ? ii => new fn(ii, fn.prototype.init)
        : ii => fn(ii);
    return new this.constructor(this, mapIter(this, mapFn));
  }

  toMap(fn_or_key) {
    let mapFn =
      typeof fn === "function" ? ii => [fn(ii), ii] : ii => [ii[fn_or_key], ii];
    return new Map(mapIter(this, mapFn));
  }

  reduce(fn, ...accumulator_opt) {
    let accumulator = accumulator_opt[0],
      hasAccumulator = accumulator_opt.length > 0;
    for (const ii of this) {
      if (!hasAccumulator) {
        accumulator = ii;
        hasAccumulator = true;
      }
      accumulator = fn(accumulator, ii);
    }
    return accumulator;
  }

  only(key, required = true) {
    let result = this.reduce((result, item) => {
      const value = item[key];
      if (result !== undefined) {
        assert(result === value);
      }
      return value;
    }, undefined);
    assert(!required || result !== undefined);
    return result;
  }

  _index(key) {
    let buckets = new Map();
    for (const ii of this) {
      const keyValue = ii[key];
      let keyPrimitive = toPrimitiveKey(keyValue, { key });
      let bucket = buckets.get(keyPrimitive);
      if (bucket === undefined) {
        bucket = {
          Class: ii.constructor,
          props: { ...this, [key]: keyValue },
          items: new Set()
        };
        buckets.set(keyPrimitive, bucket);
      }
      bucket.items.add(ii);
    }
    return buckets;
  }

  groupBy({ key }, split = false) {
    if (split) {
      return this.map(ii => ii.groupBy({ key }, false)).flat();
    }
    const Self = this.constructor;
    return new Self(
      this,
      mapIter(this._index(key).values(), b => new b.Class(b.props, b.items))
    );
  }

  joinBy({ with: on = this, key, key2 = key, leftOuter = true }, fn) {
    let index = key2 && on._index(key2);
    function* mapGen(ii) {
      let iter;
      if (index) {
        let bucket = index.get(ii[key]);
        if (bucket === undefined && !leftOuter) return;
        else if (bucket === undefined && leftOuter) iter = [null];
        else iter = bucket.items;
      } else {
        iter = on;
      }
      for (const jj of iter) {
        yield fn(ii, jj);
      }
    }
    let mapFn = ii => mapGen(ii);
    return new this.constructor(
      this,
      filterIter(flatIter(mapIter(this, mapFn)), Boolean)
    );
  }

  sort(compare = SortableScope.compare) {
    let newOrder = Array.from(this).sort(compare);
    let i = 0;
    for (const ii of this) {
      if (ii !== newOrder[i++]) {
        return new this.constructor(this, newOrder.values()); // New order.
      }
    }
    return this; // Nothing changed.
  }
}

class Annotatable extends Node {
  constructor(...args) {
    super(...args);
    if (this.suppressed === undefined) {
      let suppressed = undefined;
      for (const ii of this) {
        if (!(ii instanceof Set)) continue;
        if (ii.suppressed === null) {
          // Explicitly not applicable.
        } else if (!ii.suppressed) {
          suppressed = false;
          break;
        } else {
          suppressed = true;
        }
      }
      this.suppressed = suppressed;
    }
    for (const ii of this) {
      if (!(ii instanceof Set)) continue;
      ii.parentSuppressed = this.suppressed;
    }

    this.commentGroup = CommentGroup.fromItems(this);
    if (!this.commentSet) {
      this.commentSet = new CommentSet(this.commentGroup.values());
    }
    for (const ii of this) {
      if (!(ii instanceof Set)) continue;
      ii.parentCommentGroup = this.commentGroup;
    }
  }

  write() {
    let lines;
    let suppressedHere = this.suppressed && !this.parentSuppressed;
    if (!suppressedHere) {
      lines = this.writeInner();
    } else {
      lines = mapIter(this.writeInner(), line => "# " + line);
    }
    lines = typeof lines === "string" ? [lines] : [...lines];
    const comments = [...this.commentGroup]
      .filter(Boolean)
      .filter(
        comment =>
          !(this.parentCommentGroup && this.parentCommentGroup.has(comment))
      )
      .sort()
      .map(comment => (suppressedHere ? "## " : "# ") + comment);
    lines = [...comments, ...lines];
    return lines;
  }
}

class SortableScope extends Annotatable {
  *sortKey() {
    switch (this.constructor) {
      case GNVarPartialAssignment:
        return yield 100;
      case GNVarPartialAssignmentSection:
        return yield 110;
      case GNVarAssignedValue:
        return yield 130;
      case Crate:
        return yield 200;
      case Condition:
        return yield 300;
    }
    throw new TypeError(`Unsortable type: ${this.constructor.name}`);
  }
  static *zip(a, b) {
    for (;;) {
      let aa = a.next(),
        bb = b.next();
      let value = [aa.value, bb.value],
        done = aa.done || bb.done;
      if (done) return value;
      yield value;
    }
  }
  static compare(a, b) {
    // let dn = 0,
    // d =
    //   a instanceof GNVarPartialAssignmentSection &&
    //   b instanceof GNVarPartialAssignmentSection;
    // d = d && a.package_name === "winapi";
    // d = d && b.package_name === "winapi";
    // if (!a.sortKey) console.error(a.constructor.name);
    let sortKeyPairs = SortableScope.zip(a.sortKey(), b.sortKey());
    for (const [aa, bb] of sortKeyPairs) {
      // console.log(dn++, ":", a.gn_var, a.gn_type, aa, bb, b.gn_type, b.gn_var);
      if (aa < bb) return -1;
      if (aa > bb) return 1;
    }
  }
}

function semverOrdinal(version) {
  return version
    .split(".")
    .map(Number)
    .reduce((acc, n) => acc * 1e5 + n);
}

class UniqueStringSet extends Set {
  toPrimitiveKey() {
    return Array.from(this)
      .sort()
      .join("\t");
  }
}

class TargetTripleSet extends UniqueStringSet {
  constructor(items) {
    super(items.map(ii => ii.target_triple));
  }
}

class CommentSet extends UniqueStringSet {
  static fromItems(items) {
    let set = new CommentSet();
    for (const ii of items) {
      for (const jj of ii.commentSet) {
        set.add(jj);
      }
    }
    return set;
  }
}

class CommentGroup extends Set {
  static fromItems(items) {
    let set = new CommentGroup();
    let first = true;
    for (const ii of items) {
      const subset = ii.commentSet;
      if (subset.size === 0) continue; // Empty set -> anything goes.
      if (first) {
        for (const jj of subset) {
          set.add(jj);
        }
        first = false;
      } else {
        for (const jj of set) {
          if (!subset.has(jj)) set.delete(jj);
        }
      }
    }
    return set;
  }
}

class Root extends Node {
  init(items) {
    this.targetTriples = new TargetTripleSet(items);
    const crates = items
      .assign({ gnScope: this })
      .groupBy({ key: "package_name" })
      .groupBy({ key: "package_version" }, true)
      .groupBy({ key: "package_version_is_latest" }, true)
      .groupBy({ key: "target_name" }, true)
      .groupBy({ key: "target_type" }, true)
      .map(Crate)
      .sort();
    const conditions = crates
      .groupBy({ key: "targetTriples" })
      .map(Condition)
      .sort();
    return conditions;
  }

  writeInner() {
    return [
      ...mapIter(deepFlatIter(mapIter(this, ii => [ii.write(), ""])), line =>
        line.trimRight()
      )
    ];
  }
}

class Crate extends SortableScope {
  init(items) {
    this.targetTriples = new TargetTripleSet(items);
    this.crateName = items.target_name;
    this.crateVersion = items.package_version;
    this.gnTargetName = items.package_version_is_latest
      ? this.crateName
      : `${this.crateName}-${this.crateVersion}`;

    let gnRules = items.map(GNRule).filter(rule => !!rule.gn_var);

    // Super hacky.
    let suppressionSet = gnRules.map(rule => rule.suppressed);
    assert(!suppressionSet.has("undefined"));
    let suppressed = !suppressionSet.has(false);
    if (!items.package_version_is_latest) {
      for (const target_triple of this.targetTriples) {
        for (const gv of [
          { gn_var: "crate_name", gn_value: this.crateName },
          { gn_var: "crate_version", gn_value: this.crateVersion }
        ]) {
          gnRules = gnRules.add(
            new GNRule({
              gn_type: "string",
              ...gv,
              target_triple,
              suppressed: suppressed,
              commentSet: new CommentSet()
            })
          );
        }
      }
    }

    const gnVars = gnRules
      .assign({ crate: this, gnScope: this })
      .groupBy({ key: "gn_var" })
      .assign(ii => ({ gn_type: ii.only("gn_type") }), null)
      .map(GNVar);

    const gnAssignments = gnVars.flat();

    const scopes = gnAssignments
      .sort()
      .groupBy({ key: "targetTriples" })
      .map(Condition)
      .sort();
    return scopes;
  }
  writeHeader() {
    return `${this.target_type}("${this.gnTargetName}") {`;
  }
  *sortKey() {
    yield* super.sortKey();
    yield -this.package_version_is_latest; // Up-to-date crates first.
    yield this.crateName; // A-Z.
    yield semverOrdinal(this.crateVersion); // semver low => high.
  }
}

class GNRule extends Node {
  init(items) {
    let commentSet = new CommentSet();
    if (items.comment) {
      commentSet.add(items.comment);
    }
    if (items.override_comment) {
      commentSet.add(items.override_comment);
    }
    commentSet.add("");
    this.commentSet = commentSet;

    switch (items.rustflag) {
      case "--cfg":
        let m = /^feature=(".*")$/.exec(items.value);
        if (m) {
          return {
            gn_type: "list_string",
            gn_var: "features",
            gn_value: JSON.parse(m[1])
          };
        }
        return { gn_type: "list_string", gn_var: "cfg", gn_value: items.value };
      case "--cap-lints":
        return {
          gn_type: "list_raw",
          gn_var: "args",
          gn_value: ["--cap-lints", items.value].map(JSON.stringify).join(",\n")
        };
      case "-l": {
        let { name, kind, target_triple } = items;
        if (kind === "static") {
          // Static libraries are added in as dep and not a lib.
          return;
        } else if (kind === "framework") {
          name += ".framework";
        } else if (/windows/.test(target_triple)) {
          name += ".lib";
        }
        return {
          gn_type: "list_string",
          gn_var: "libs",
          gn_value: name
        };
      }
    }
    switch (items.source) {
      case "rs":
        return {
          gn_type: "string",
          gn_var: "source_root",
          gn_value: items.path
        };
      case "cc":
        return {
          gn_type: "list_string",
          gn_var: "sources",
          gn_value: items.path
        };
    }
    switch (items.input) {
      case "object":
        return {
          gn_type: "list_string",
          gn_var: "libs",
          gn_value: items.path
        };
    }
    switch (items.cflag) {
      case "-I":
        return {
          gn_type: "list_string",
          gn_var: "include_dirs",
          gn_value: items.path
        };
      case undefined:
        break;
      default:
        if (!items.force) break;
        return {
          gn_type: "list_string",
          gn_var: "cflags",
          gn_value: items.cflag
        };
    }
    switch (items.dep_target_type) {
      case "static_library": {
        let { dep_version, dep_crate_name, dep_version_is_latest } = items;
        const gn_label = dep_version_is_latest
          ? `:${dep_crate_name}`
          : `:${dep_crate_name}:${dep_version}`;
        return {
          gn_type: "list_string",
          gn_var: "deps",
          gn_value: gn_label
        };
      }
      case "rust_crate": {
        let { dep_version, dep_crate_name, dep_version_is_latest } = items;
        if (dep_version_is_latest) {
          return {
            gn_type: "list_string",
            gn_var: "extern",
            gn_value: `:${dep_crate_name}`
          };
        } else {
          const $ = JSON.stringify;
          return {
            gn_type: "list_raw",
            gn_var: "extern_version",
            gn_value: [
              `{`,
              `  crate_name = ${$(dep_crate_name)}`,
              `  crate_version = ${$(dep_version)}`,
              `}`
            ].join("\n")
          };
        }
      }
    }
  }
}

class GNVar extends Node {
  init(items) {
    this.gn_type = items.only("gn_type");

    const assignedValues = items
      .assign({ gn_type: this.gn_type })
      .groupBy({ key: "gn_value" })
      .groupBy({ key: "suppressed" }, true)
      .map(GNVarAssignedValue);

    // Huge kluge to figure out whether the partial assignment is the first
    // within a (crate) scope. This is to determine whether we add list items
    // with `=` or `+=`.
    const targetTriples = new TargetTripleSet(items);
    const triplesAwaitingFirstAssignment = new Set(targetTriples);

    // Group by the same key twice so we get buckets with exactly one entry.
    // This lets us flatten away the Condition object in the end and
    // remap it to a PartialAssignment.
    return assignedValues
      .groupBy({ key: "targetTriples" })
      .groupBy({ key: "targetTriples" })
      .map(Condition)
      .sort()
      .map(condition => {
        let triples = Array.from(condition.targetTriples);
        let isFirstAny = triples.every(t =>
          triplesAwaitingFirstAssignment.has(t)
        );
        let isFirstAll = triples.some(t =>
          triplesAwaitingFirstAssignment.has(t)
        );
        triples.forEach(t => triplesAwaitingFirstAssignment.delete(t));
        assert(isFirstAny === isFirstAll, "Unsupported condition. Fixme.");
        return condition.assign({ isFirstAssignment: isFirstAny });
      })
      .flat()
      .map(GNVarPartialAssignment);
  }
}

class GNVarAssignedValue extends SortableScope {
  init(items) {
    this.targetTriples = new TargetTripleSet(items);
    this.commentSet = CommentSet.fromItems(items);
  }

  writeInner() {
    let { gn_var, gn_type, gn_value: out } = this;
    // TODO: gn_string() ... ?
    if (/string$/.test(gn_type)) out = JSON.stringify(out);
    if (/^list_/.test(gn_type)) {
      out += ",";
    } else {
      out = gn_var + " = " + out;
    }
    return out
      .split("\n")
      .map(s => s.trimRight())
      .filter(Boolean);
  }

  *sortKey() {
    yield* super.sortKey();
    yield this.gn_value;
  }
}

class GNVarPartialAssignment extends SortableScope {
  constructor(...args) {
    super(...args);
  }
  init(items) {
    return items
      .groupBy({ key: "commentSet" })
      .groupBy({ key: "suppressed" }, true)
      .map(GNVarPartialAssignmentSection)
      .sort();
  }
  writeInner() {
    if (!/^list/.test(this.gn_type)) {
      return Array.from(this).map(ii => ii.write());
    } else {
      let childLines = this.writeChildren();
      if (childLines.length <= 1) {
        return [
          [
            this.writeHeader(),
            ...childLines.map(s => s.replace(/^\s*(.*),\s*$/, " $1 ")),
            this.writeFooter()
          ].join("")
        ];
      } else {
        return super.writeInner();
      }
    }
  }
  writeHeader() {
    let op = this.isFirstAssignment ? "=" : "+=";
    return `${this.gn_var} ${op} [`;
  }
  writeSpacing() {
    return "";
  }
  writeFooter() {
    return `]`;
  }
  writeSpacing() {
    return [""];
  }
  *sortKey() {
    yield* super.sortKey();
    assert(this.gn_var && this.gn_type);
    yield +this.suppressed; // Suppressed rules last.
    yield this.commentSet.size; // Comments last.
    yield* this.commentSet.values();
    yield this.gn_type === "string" ? 0 : 1; // Primitive values first.
    yield +(this.gn_var === "args"); // 'args' last.
    yield +/^extern|^(deps|libs)$/.test(this.gn_var); // deps last.
    yield this.gn_var; // A-Z.
  }
}

class GNVarPartialAssignmentSection extends SortableScope {
  init(items) {
    return items.sort();
  }
  writeHeader() {}
  writeFooter() {}
  writeItem(str) {
    return str;
  }
  *sortKey() {
    yield* super.sortKey();
    yield +this.suppressed; // Suppressed rules last.
    yield this.commentSet.size;
    yield* this.commentSet.values();
  }
}

let target_triple_gn_if = new Map([
  ["x86_64-apple-darwin", "is_mac"],
  ["x86_64-pc-windows-msvc", "is_win"],
  ["x86_64-unknown-linux-gnu", "is_linux"],
  ["x86_64-unknown-freebsd", 'current_os == "freebsd"'],
  ["x86_64-linux-android", "is_android"]
]);
let target_triple_is_posix = triple =>
  target_triple_gn_if.has(triple) &&
  target_triple_gn_if.get(triple) !== "is_win";
class Condition extends SortableScope {
  init(items) {
    this.gn_if = this.getGNCondition(items);
    return items.assign({ condition: this });
  }
  getGNCondition(items) {
    let innerTriples = items.targetTriples;
    let outerTriples = items.gnScope.targetTriples;
    // Outer triples should be a superset of inner triples.
    assert([...innerTriples].every(t => outerTriples.has(t)));
    if (innerTriples.size === outerTriples.size) {
      return [];
    } else if (
      innerTriples.size > 1 &&
      Array.from(outerTriples).every(
        t => innerTriples.has(t) === target_triple_is_posix(t)
      )
    ) {
      return ["is_posix"];
    } else {
      return Array.from(innerTriples)
        .map(t => target_triple_gn_if.get(t))
        .sort();
    }
  }
  *sortKey() {
    yield* super.sortKey();
    yield +this.suppressed; // Suppressed scopes last.
    // More generic.
    yield (1000 * this.gn_if.length) / this.targetTriples.size;
    // More inclusive.
    yield -this.targetTriples.size;
    // Alphabetically.
    yield* this.gn_if;
  }

  if(yes, no = []) {
    return this.gn_if.length > 0 ? yes : no;
  }
  writeHeader() {
    return this.if(`if (${this.gn_if.join(" || ")}) {`);
  }
  writeItem(str) {
    return this.if("  ", "") + str;
  }
  writeFooter() {
    return this.if("}");
  }
}

//const records = require("./records.json").map(r => new RustArg(r));
//const root = new Root(records.values(), Root.prototype.init);
//
//require("fs").writeFileSync("a.gn", [...root.write()].join("\n"));

///

function parseRustcArgs(args) {
  // Process args into something more useful.
  // 1. Break up combined shorthand flags (`-OgvV`) into individual ones.
  return (
    args
      .map(
        arg =>
          /^-[^-]/.test(arg)
            ? arg
                .slice(1)
                .split("")
                .map(a => `-${a}`)
            : arg
      )
      .reduce(...flat)
      // 2. Canonicalize.
      .map(
        arg =>
          ({
            "-v": "--verbose",
            "-V": "--version",
            "-g": "--codegen=debuginfo=2",
            "-O": "--codegen=opt-level=2",
            "-h": "--help",
            "-A": "--allow",
            "-W": "--warn",
            "-D": "--deny",
            "-F": "--forbid",
            "-C": "--codegen"
          }[arg] || arg)
      )
      // 3. Split & pair.
      .map(arg => {
        let m =
          /^(-.*?)(?:=(.*))/.exec(arg) ||
          /^(--(?:version|verbose|help|test))()$/.exec(arg);
        return m ? m.slice(1) : arg;
      })
      .reduce(...flat)
      .reduce(
        (arr, arg) =>
          /^-/.test(arg)
            ? Object.assign(arr, { rustflag: arg })
            : [...arr, { rustflag: arr.rustflag || "", value: arg }],
        []
      )
      // Split multiple comma separated values (`--emit=link,dep`).
      .map(({ rustflag, value }) =>
        (value || "").split(",").map(value => ({ rustflag, value }))
      )
      .reduce(...flat)
      // Split `kind=lib` and `name=path` etc values.
      .map(o =>
        /^(?:(.+?)=(.+)|.*)$/
          .exec(o.value)
          .map((v, i) => [
            v,
            ({
              "-l": ["name", "kind", "name"],
              "-L": ["path", "kind", "path"],
              "--codegen": ["optname", "optname", "optval"],
              "--emit": ["kind", "kind", "path"],
              "--extern": ["crate_name", "crate_name", "path"]
            }[o.rustflag] || [])[i]
          ])
          .filter(([v, key]) => v && key)
          .reduce((o, [v, k]) => ({ ...o, [k]: v }), o)
      )
      // Default `kind` values for -l and -L flags.
      .map(
        o =>
          ({ "-l": { kind: "dylib", ...o }, "-L": { kind: "all", ...o } }[
            o.rustflag
          ] || o)
      )
      // Values with no associated rustflag are source files.
      .map(o => (o.rustflag ? o : { source: "rs", path: o.value }))
  );
}

function parseCargoDirectives(lines) {
  let args = lines
    .map(line => /^cargo:([^=]+)=(.*)$/.exec(line))
    .map(([line, key, value]) => {
      switch (key) {
        case "rustc-cfg":
          return ["--cfg", value];
        case "rustc-link-lib":
          return ["-l", value];
        case "rustc-link-search":
          return ["-L", value];
        case "rerun-if-changed":
        case "rerun-if-env-changed":
          return; // Ignore
        default:
          fail(
            `Unsupported cargo instruction in custom_build output: ${line}\n` +
              "Note that arbitrary metadata isn't currently supported.",
            stdout
          );
      }
    })
    .filter(Boolean)
    .reduce(...flat);
  args = parseRustcArgs(args).map(arg => ({
    ...arg,
    comment: "Added by custom-build script."
  }));
  return args;
}

function parseSourceLinkAttributes(entries, cmd) {
  const { cwd, target } = cmd;
  return entries
    .map(({ path, line }) => {
      const relPath = relative(cwd, path).replace(/\\/g, "/");
      const m = /^\s*#\[link\((.*)\)\]\s*$/.exec(line);
      if (!m) return;
      const props = {};
      let triples;
      const parts = m[1].trim().split(/\s*,\s*/);
      for (const part of parts) {
        const kv = /^\s*(name|kind)\s*=\s*(.*)\s*$/.exec(part);
        if (!kv) {
          throw new Error(`Failed to parse '${part}' of '${line}'`);
        }
        const key = kv[1],
          value = JSON.parse(kv[2]);
        props[key] = value;
        if (key === "name") {
          triples = {
            Security: ["x86_64-apple-darwin"],
            advapi32: ["x86_64-pc-windows-msvc"],
            bsd: [],
            c: [],
            errno_dragonfly: [],
            fdio: [],
            libcmt: [],
            m: [],
            msvcrt: [],
            network: [],
            ole32: ["x86_64-pc-windows-msvc"],
            oleaut32: ["x86_64-pc-windows-msvc"],
            pthread: [],
            root: [],
            rt: [],
            rt: [],
            util: []
          }[value];
          if (!triples) {
            throw new Error(`Don't know what targets to apply '${line}' to.`);
          }
          if (!triples.includes(target)) return;
        }
      }
      const comment = `Per the #[link(...)] attribute found in '${relPath}'.`;
      return { rustflag: "-l", value: props.name, ...props, comment };
    })
    .filter(Boolean);
}

function mergeRustcArgs(...argSets) {
  let getKey = arg =>
    [arg.rustflag || arg.source, arg.value, arg.comment || ""].join("\0");
  let merge = (...sets) =>
    new Map(
      [...sets]
        .map(set => [...set])
        .reduce(...flat)
        .map(a => [getKey(a), a])
    );
  // Sanity check.
  for (const set of argSets) {
    assert(set instanceof Set);
    assert(set.size === merge(set).size);
  }
  // Do the merge.
  let Class = argSets[0].constructor;
  return new Class(merge(...argSets).values());
}

function parseArArgs(args, cwd) {
  let [flags, archive, ...inputs] = args;
  let argsOut = [];
  // Flags.
  assert(/^[a-z]+/.test(flags));
  argsOut.push({ arflag: flags });
  // Archive.
  assert(/\.a$/.test(archive));
  argsOut.push({ output: "static_lib", path: resolve(cwd, archive) });
  // Inputs.
  argsOut.push(
    ...inputs.map(input => {
      assert(/\.(o|obj)$/.test(input));
      return { input: "object", path: resolve(cwd, input) };
    })
  );
  return argsOut;
}

function parseCcArgs([...args], cwd) {
  let argsOut = [];
  let arg;
  while ((arg = args.shift())) {
    if (/^-/.test(arg)) {
      let cflag = arg;
      let value, path;
      let m = /^(-[Io])(.*)$/.exec(cflag);
      if (m) {
        [, cflag, value] = m;
        value = value || args.shift();
        path = resolve(cwd, value);
      }
      let output = { "-o": "object" }[cflag];
      argsOut.push({ cflag, value, path, output });
    } else {
      assert(/\.(c|cc|cpp|S|asm)$/.test(arg));
      argsOut.push({ source: "cc", path: resolve(cwd, arg) });
    }
  }
  return argsOut;
}

function parseLibArgs([...args], cwd) {
  let argsOut = [];
  let arg;
  while ((arg = args.shift())) {
    let m = /^(\/[^:]+)(?::(.*))?$/.exec(arg);
    if (m) {
      let [, libflag, value] = m;
      let output, path;
      switch (libflag) {
        case "/OUT":
          output = "static_lib";
        // Fall through.
        case "/DEF":
        case "/LIST":
        case "/LIBPATH":
        case "/NAME":
        case "/OUT":
          path = resolve(cwd, value);
      }
      argsOut.push({ libflag, value, output, path });
    } else {
      assert(/\.(o|obj)$/.test(arg));
      argsOut.push({ input: "object", path: resolve(cwd, arg) });
    }
  }
  return argsOut;
}

function parseClArgs([...args], cwd) {
  let argsOut = [];
  let arg;
  while ((arg = args.shift())) {
    let m = /^[\/-](.*)$/.exec(arg);
    if (m) {
      let cflag = `-${m[1]}`;
      let value, path;
      let m2 = /^(-Fo|-I)(.*)$/.exec(cflag);
      if (m2) {
        [, cflag, value] = m2;
        value = value || args.shift();
        path = resolve(cwd, value);
      }
      let output = { "-Fo": "object" }[cflag];
      argsOut.push({ cflag, value, path, output });
    } else {
      assert(/\.(c|cc|cpp|S|asm)$/.test(arg));
      argsOut.push({ source: "cc", path: resolve(cwd, arg) });
    }
  }
  return argsOut;
}

class Command extends Node {
  init(v) {
    let { args, env, ...base } = v;
    Object.assign(this, v);

    // Set package info.
    this.package_name = env.CARGO_PKG_NAME;
    this.package_version = env.CARGO_PKG_VERSION;
    this.package_dir = env.CARGO_MANIFEST_DIR;
    this.package_id = `${this.package_name}-${this.package_version}`;

    // Env.
    this.env = env;

    // Set args.
    switch (base.program) {
      case "rustc":
        let parsed_args = parseRustcArgs(v.args);
        let attrs = v.source_file_link_attributes;
        if (attrs) {
          parsed_args.push(...parseSourceLinkAttributes(attrs, v));
        }
        this.args = new Node(parsed_args.values());
        break;
      case "build-script-build":
        this.output_args = new Node(
          parseCargoDirectives(v.output_cargo_directives).values()
        );
        break;
      case "ar":
        this.args = new Node(parseArArgs(v.args, v.cwd).values());
        break;
      case "cc":
        this.args = new Node(parseCcArgs(v.args, v.cwd).values());
        break;
      case "cl":
        this.args = new Node(parseClArgs(v.args, v.cwd).values());
        break;
      case "lib":
        this.args = new Node(parseLibArgs(v.args, v.cwd).values());
        break;
    }

    // Set output.
    let outputs;
    if (["ar", "cc", "lib", "cl"].includes(base.program)) {
      outputs = [...this.args].filter(a => a.output).map(a => a.path);
      assert(outputs.length === 1);
    } else if (base.program === "rustc") {
      outputs = v.outputs;
    }
    if (outputs) {
      assert(outputs.length < 2, "more than 1 output not expected");
      this.output = outputs[0];
    }

    // Target type.
    this.target_type = {
      rustc: "rust_crate",
      ar: "static_library",
      lib: "static_library",
      cc: "source_set",
      cl: "source_set"
    }[base.program];

    // Set target_name.
    if (base.program === "rustc") {
      this.target_name = this.args
        .filter(a => a.rustflag === "--crate-name")
        // `crate-name` is sometimes missing.
        // TODO: filter those non-target rustc invocations earlier.
        .only("value", false);
    } else if (this.output) {
      let output_filename = basename(this.output);
      this.target_name = [
        /^lib(.*)\.a$/,
        /^(.*)\.(?:o|obj|lib|exe)$/,
        /^([^\.]+)$/
      ]
        .map(re => re.exec(output_filename))
        .filter(Boolean)
        .map(m => m[1])
        .shift();
    }
  }
}

let overrides = [
  {
    init() {
      this.old = new Map();
      this.latest = null;
    },
    packageId(rec) {
      return `${rec.package_name}-${rec.package_version}`;
    },
    kind: "dep",
    match(dep, depender) {
      return dep.target_name === "rand" && !dep.package_version_is_latest;
    },
    replace(dep, depender, candidates) {
      let r = candidates.find(
        c => c.target_name === dep.target_name && c.package_version_is_latest
      );
      this.old.set(this.packageId(depender), dep.package_version);
      this.latest = r.package_version;
      return r;
    },
    comment(rec, d, ch) {
      let old = this.old.get(this.packageId(rec));
      return (
        `Override: use rand v${this.latest} instead` +
        (old ? ` of v${old}.` : ".")
      );
    }
  },
  {
    kind: "record",
    match: record => Object.values(record).some(v => /owning[-_]ref/.test(v)),
    replace: (record, all_records) => null,
    comment: "Override: avoid dependency on on 'owning-ref'."
  },
  {
    kind: "dep",
    match: dep => dep.target_name === "ring-test",
    replace: (record, all_records) => null,
    comment: "Override: don't build 'ring-test' static library."
  },
  {
    comment: "Override: no fuchsia stuff.",
    kind: "record",
    match: record => Object.values(record).some(v => /fuchsia/.test(v)),
    replace: (record, all_records) => null
  },
  {
    comment: `Suppress "warning: '_addcarry_u64' is not a recognized builtin."`,
    kind: "record",
    match(rec) {
      return (
        rec.target_name === "ring-core" &&
        /windows/.test(rec.target_triple) &&
        rec.libflag
      );
    },
    replace(rec) {
      let { output, value, path, libflag, ...keep } = rec;
      return [
        rec, // Insert -- don't replace.
        new rec.constructor({
          cflag: "-Wno-ignored-pragma-intrinsic",
          ...keep,
          force: true
        })
      ];
    }
  },
  {
    comment: `Supress "warning: '_GNU_SOURCE' macro redefined."`,
    kind: "record",
    match(rec) {
      return (
        rec.target_name === "ring-core" &&
        /linux/.test(rec.target_triple) &&
        rec.arflag
      );
    },
    replace(rec) {
      let { output, value, path, libflag, ...keep } = rec;
      return [
        rec, // Insert -- don't replace.
        new rec.constructor({
          cflag: "-Wno-macro-redefined",
          ...keep,
          force: true
        })
      ];
    }
  }
];

function generate(trace_output) {
  const commands = new Node(Array.from(trace_output).values())
    .map(Command)
    .map(Object.freeze);

  let outputRootDir = commands
    .map(cmd => cmd.output)
    .filter(Boolean)
    .map(dirname)
    .reduce((root, path) => {
      while (!path.startsWith(root)) root = root.slice(0, -1);
      return root;
    });

  for (const override of overrides) {
    override.init && override.init();
  }

  let currentRecords;
  let recordOverrides = [];

  let override_baseline = { kind: null, baseline: true };
  for (let oi = 0; oi <= overrides.length; oi++) {
    const current_overrides = [override_baseline, ...overrides.slice(0, oi)];

    let records = commands
      .filter(cmd => cmd.package_name)
      .groupBy({ key: "package_name" })
      .map(packageCommands => {
        const versions = packageCommands.groupBy({ key: "package_version" });
        const latest_version = versions
          .map(pkg => pkg.package_version)
          .reduce(
            (latest, version) =>
              !latest || semverOrdinal(version) > semverOrdinal(latest)
                ? version
                : latest
          );
        return packageCommands.map(
          cmd =>
            new cmd.constructor(cmd, {
              package_version_is_latest: cmd.package_version === latest_version
            })
        );
      })
      .flat();

    records = records
      .groupBy({ key: "target" })
      // Merge the little bit of relevant information from build-script-build
      // targets into regular rustc targets. Drop rust commands with no output
      // and those that were built for the host (usually build-script-build deps).
      .map(target_commands => {
        return (
          target_commands
            .filter(cmd => cmd.program !== "build-script-build")
            .filter(cmd => cmd.target_name !== "build_script_build")
            .filter(cmd => cmd.output)
            //.filter(cmd => !!cmd.env.HOST)
            .joinBy(
              {
                key: "package_id",
                with: target_commands.filter(
                  cmd => cmd.program === "build-script-build"
                )
              },
              (l, r) => {
                if (l.program !== "rustc" || !r) return l;
                return new Node(l, {
                  args: mergeRustcArgs(l.args, r.output_args)
                });
              }
            )
        );
      })
      .map(target_commands => {
        let outputMap = new Map(target_commands.map(cmd => [cmd.output, cmd]));
        return target_commands.map(cmd => {
          // Replace object file inputs by the source file that they were generated
          // from.
          let args = cmd.args
            .map(a => {
              if (a.input === "object" && a.path.startsWith(outputRootDir)) {
                assert(outputMap.has(a.path));
                return outputMap.get(a.path).args;
              } else {
                return new Node([a].values());
              }
            })
            .flat();
          return new cmd.constructor(cmd, { args });
        });
      })
      .map(target_commands => {
        // Find the command that builds the final output. Then work backwards and find
        // all deps.
        let outputMap = new Map(target_commands.map(cmd => [cmd.output, cmd]));
        let primary = target_commands.filter(
          cmd => cmd.env.CARGO_PRIMARY_PACKAGE
        );
        assert(primary.size === 1);
        return new Node(findDeps(...primary).values());

        function findDeps(cmd, alreadyIncluded = new Set()) {
          if (alreadyIncluded.has(cmd.output)) return [];
          alreadyIncluded.add(cmd.output);

          let depCommands = [];
          // Find rust deps.
          depCommands.push(
            ...cmd.args.filter(a => a.rustflag === "--extern").map(a => {
              assert(outputMap.has(a.path));
              return outputMap.get(a.path);
            })
          );
          // Find static library deps.
          let libDirs = cmd.args
            .filter(a => a.rustflag === "-L")
            .map(a => a.path);
          depCommands.push(
            ...cmd.args
              .filter(a => a.rustflag === "-l" && a.kind === "static")
              .map(a => a.name)
              .map(name => {
                for (const dir of libDirs) {
                  for (const pattern of [n => `lib${n}.a`, n => `${n}.lib`]) {
                    const path = resolve(dir, pattern(name));
                    if (outputMap.has(path)) {
                      return outputMap.get(path);
                    }
                  }
                }
                assert.fail("Could not resolve deps.");
              })
              .filter(Boolean)
          );
          // Apply dep-level overrides.
          for (const override of current_overrides) {
            if (override.kind !== "dep") continue;
            depCommands = depCommands
              .map(
                dep =>
                  override.match(dep, cmd)
                    ? override.replace(dep, cmd, Array.from(target_commands))
                    : dep
              )
              .filter(dep => dep !== null)
              .reduce(...flat);
          }
          // Extract dep info that we need to keep associated with this cmd.
          let deps = depCommands.map(dep => ({
            dep_target_type: dep.target_type,
            dep_name: dep.package_name,
            dep_version: dep.package_version,
            dep_version_is_latest: dep.package_version_is_latest,
            dep_crate_name: dep.target_name
          }));
          cmd = new cmd.constructor(cmd, { deps });
          // Return self + outputs;
          return [
            cmd,
            ...depCommands
              .map(dep => findDeps(dep, alreadyIncluded))
              .reduce(...flat)
          ];
        }
      })
      .flat()
      // Now drop the primary package itself.
      .filter(cmd => !cmd.env.CARGO_PRIMARY_PACKAGE);

    class RustArg extends Node {
      init(items) {}
      get mapKey() {
        return JSON.stringify(this);
      }
    }

    records = records
      // Flatten all records to one arg per row.
      .map(record => {
        let {
          package_name,
          package_version,
          package_version_is_latest,
          package_dir,
          target_name,
          target_type,
          target: target_triple,
          deps,
          args
        } = record;
        assert(target_type != null);
        return [...args, ...deps].map(
          a =>
            new RustArg({
              package_name,
              package_version,
              package_version_is_latest,
              package_dir,
              target_name,
              target_type,
              target_triple,
              ...a
            })
        );
      })
      .flat();

    // Apply record-level overrides.
    for (const override of current_overrides) {
      if (override.kind !== "record") continue;
      records = records
        .map(
          record =>
            override.match(record)
              ? override.replace(record, Array.from(records))
              : record
        )
        .filter(record => record !== null)
        .reduce(...flat);
    }

    // Remember which records were affected by which overrides.
    let override = current_overrides[current_overrides.length - 1];
    let newRecords = new Map(records.map(r => [r.mapKey, r]));
    if (currentRecords) {
      // Compute the difference.
      let added = new Map(newRecords),
        dropped = new Map();
      for (const [key, rec] of currentRecords) {
        if (added.has(key)) added.delete(key);
        else dropped.set(key, rec);
      }
      // Ask the override for a comment.
      for (const map of [dropped, added]) {
        let commentArgs = [
          map === dropped ? "-" : "+",
          { "-": [...dropped.values()], "+": [...added.values()] }
        ];
        for (let [key, rec] of map) {
          let override_comment =
            typeof override.comment === "function"
              ? override.comment(rec, ...commentArgs)
              : override.comment;
          rec = new rec.constructor(rec, { override_comment });
          recordOverrides.push([key, rec]);
        }
      }
    }
    currentRecords = newRecords;
  }

  // Add historical records to the current set but with the 'suppressed' flag on.
  let records = new Node(
    (function* merge() {
      for (const [key, rec] of recordOverrides) {
        yield new rec.constructor(rec, {
          suppressed: !currentRecords.has(key)
        });
      }
      for (const rec of currentRecords.values()) {
        yield new rec.constructor(rec, { suppressed: false });
      }
    })()
  );

  // Remap paths.
  records = records.map(record => {
    let { path } = record;
    if (!path) return record;
    // Use forward slashes.
    path = path.replace(/\\/g, "/");
    // Replace root by a variable.
    path = path.replace(
      /(^.*(?=\/registry\/src))|(^(.*\/)?third_party\/rust_crates(?=\/))/,
      "$cargo_home"
    );
    return new record.constructor(record, { path });
  });

  // Build the GN scope from the ground up.
  let root = new Root(records, Root.prototype.init);
  // Render the gn file.
  let build_gn_lines = root.write();
  let build_gn = [...build_gn_lines].map(l => `${l}\n`).join("");

  // Build a list of package paths.
  let package_dirs = Array.from(
    records
      .filter(rec => !rec.suppressed)
      .map(rec => rec.package_dir)
      .filter(Boolean)
  ).sort();

  return { build_gn, package_dirs };
}
