"use strict";

const assert = require("assert");
const semver = require("semver");
const { resolve, basename, extname, dirname, relative } = require("path");
const { readFileSync, writeFileSync, readDirSync } = require("fs");
const { inspect } = require("util");
const {
  execFile,
  spawn,
  readFile,
  writeFile,
  mkdir,
  mkdtemp
} = require("./lib/async");
const { searchDir, exeSuffix, flat, main } = require("./lib/util");

const WORK_DIR = process.argv[2] || `${__dirname}/work`;

main(async () => {
  const commands = JSON.parse(
    await readFile(`${WORK_DIR}/commands.json`, "utf8")
  );
  let { package_dirs, generated_files, build_gn } = generate(commands);

  for (const [gen_file_path, gen_file_content] of Object.entries(
    generated_files
  )) {
    const gen_file_dir = dirname(gen_file_path);
    await mkdir(gen_file_dir, { recursive: true });
    await writeFile(gen_file_path, gen_file_content);
    console.log(`Saved generated file. ${gen_file_path}`);
  }

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
    .map(c => c.cwd)
    .filter(Boolean)
    .sort((a, b) => a.length - b.length)
    .shift();
  return (await searchDir(
    `${denoSourceDir}/third_party/v8/buildtools`,
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
          mapIter(mapIter(this, ii => ii.write()), ii =>
            !num++ ? ii : [this.writeSpacing(ii), ii]
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
    let sortKeyPairs = SortableScope.zip(a.sortKey(), b.sortKey());
    for (const [aa, bb] of sortKeyPairs) {
      if (aa < bb) return -1;
      if (aa > bb) return 1;
    }
  }
}

function semverOrdinal(version) {
  // Not exactly correct, but good enough.
  return `${version}.0`
    .replace(/([+-]).*$/, ".$11")
    .split(/\.|(?=[+-])/)
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
      .groupBy({ key: "package_version_is_canonical" }, true)
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
    this.gnTargetName = items.package_version_is_canonical
      ? this.crateName
      : `${this.crateName}-${this.crateVersion}`;

    let gnRules = items.map(GNRule).filter(rule => !!rule.gn_var);

    // Super hacky.
    let suppressionSet = gnRules.map(rule => rule.suppressed);
    assert(!suppressionSet.has("undefined"));
    let suppressed = !suppressionSet.has(false);
    if (!items.package_version_is_canonical) {
      for (const target_triple of this.targetTriples) {
        for (const gv of [
          GN.assignment("crate_name", this.crateName),
          GN.assignment("crate_version", this.crateVersion)
        ]) {
          gnRules = gnRules.add(
            new GNRule({
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
      .assign(ii => ({ gn_kind: ii.only("gn_kind") }), null)
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
    yield -this.package_version_is_canonical; // Up-to-date crates first.
    yield this.crateName; // A-Z.
    yield semverOrdinal(this.crateVersion); // semver low => high.
    yield this.crateVersion;
  }
}

class GN {
  static stringify(val) {
    const $ = GN.stringify;

    if (typeof val === "string") {
      // TODO: actually implement this instead of using JSON.stringify.
      return JSON.stringify(val);
    } else if (Array.isArray(val)) {
      const items = val.filter(v => v !== undefined);
      switch (items.length) {
        case 0:
          return `[]`;
        case 1:
          return `[ ${$(items[0])} ]`;
        default:
          return [`[`, ...items.map(v => `  ${$(v)},`), `]`].join("\n");
      }
    } else if (val && typeof val === "object") {
      const entries = [...Object.entries(val)].filter(
        ([k, v]) => v !== undefined
      );
      return [`{`, ...entries.map(([k, v]) => `  ${k} = ${$(v)}`), `}`].join(
        "\n"
      );
    } else {
      assert.fail("Can't convert value for gn.");
    }
  }

  static assignment(var_name, value) {
    return {
      gn_kind: "assignment",
      gn_var: var_name,
      gn_value: GN.stringify(value)
    };
  }

  static list_item(list_var_name, ...items) {
    return {
      gn_kind: "list_item",
      gn_var: list_var_name,
      gn_value: items.map(GN.stringify).join(",\n")
    };
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
      case "--cfg": {
        let m = /^feature=(".*")$/.exec(items.value);
        if (m) {
          return GN.list_item("features", JSON.parse(m[1]));
        } else {
          return GN.list_item("cfg", items.value);
        }
      }
      case "--cap-lints":
        return GN.assignment("cap_lints", items.value);
      case "--edition": {
        const edition = items.value;
        if (edition === "2018") return;
        return GN.assignment("edition", edition);
      }
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
        return GN.list_item("libs", name);
      }
    }
    switch (items.source) {
      case "rs":
        return GN.assignment("source_root", items.path);
      case "cc":
        return GN.list_item("sources", items.path);
    }
    switch (items.generated) {
      case "dir":
        return GN.assignment("generated_source_dir", items.path);
    }
    switch (items.input) {
      case "object":
        return GN.list_item("libs", items.path);
    }
    switch (items.cflag) {
      case "-I":
        return GN.list_item("include_dirs", items.path);
      case undefined:
        break;
      default:
        if (!items.force) break;
        return GN.list_item("cflags", items.cflag);
    }
    switch (items.dep_target_type) {
      case "static_library": {
        let { dep_version, dep_crate_name, dep_version_is_canonical } = items;
        const gn_label = dep_version_is_canonical
          ? `:${dep_crate_name}`
          : `:${dep_crate_name}:${dep_version}`;
        return GN.list_item("deps", gn_label);
      }
      case "rust_rlib":
      case "rust_proc_macro": {
        const $ = JSON.stringify;
        const {
          dep_crate_alias,
          dep_crate_name,
          dep_version,
          dep_version_is_canonical
        } = items;
        const dep_crate_type = {
          rust_rlib: "rlib",
          rust_proc_macro: "proc_macro"
        }[items.dep_target_type];

        if (
          dep_crate_name === dep_crate_alias &&
          dep_crate_type === "rlib" &&
          dep_version_is_canonical
        ) {
          // Common case; store dependency in the `extern_rlib` list.
          return GN.list_item("extern_rlib", dep_crate_name);
        } else {
          // Special case: store extended dependency info in the `extern` list.
          const extern = {
            label: dep_version_is_canonical
              ? `:${dep_crate_name}`
              : `:${dep_crate_name}-${dep_version}`,
            crate_type: dep_crate_type,
            crate_name: dep_crate_name,
            crate_version: dep_version_is_canonical ? undefined : dep_version,
            crate_alias:
              dep_crate_name === dep_crate_alias ? undefined : dep_crate_alias
          };
          return GN.list_item("extern", extern);
        }
      }
    }
    if (items.env_key) {
      return GN.list_item("env", `${items.env_key}=${items.env_value}`);
    }
  }
}

class GNVar extends Node {
  init(items) {
    this.gn_kind = items.only("gn_kind");

    const assignedValues = items
      .assign({ gn_kind: this.gn_kind })
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
    const { gn_var, gn_kind, gn_value } = this;
    let gn_code;
    switch (gn_kind) {
      case "assignment":
        gn_code = gn_var + " = " + gn_value;
        break;
      case "list_item":
        gn_code = gn_value + ",";
        break;
      default:
        assert.fail(`Unexpected gn_kind: ${gn_kind}`);
    }
    return gn_code
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
    if (!/^list/.test(this.gn_kind)) {
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
    assert(this.gn_var && this.gn_kind);
    yield +this.suppressed; // Suppressed rules last.
    yield this.commentSet.size; // Comments last.
    yield* this.commentSet.values();
    yield this.gn_kind === "assignment" ? 0 : 1; // Single values before lists.
    yield +(this.gn_var === "args"); // 'args' last.
    yield +/^extern|^(deps|libs)$/.test(this.gn_var); // deps last.
    yield +(this.gn_var === "extern"); // 'extern_rlib' before 'extern'.
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
      .map(arg =>
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
              "--extern": ["crate_alias", "crate_alias", "path"]
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
          assert.fail(
            `Unsupported cargo instruction in custom build script output:\n` +
              `  ${line}\n` +
              `Note that arbitrary metadata isn't currently supported.`,
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

function parseGeneratedFiles(generated_files, cmd) {
  const { CARGO_MANIFEST_DIR: package_dir, OUT_DIR: out_dir } = cmd.env;
  const package_gen_dir = package_dir.replace(/\bsrc\b/, "gen");
  const gen_file_args = Object.entries(generated_files)
    .map(([path, lines]) => ({
      gen_file_name: relative(out_dir, path),
      gen_file_content: lines.map(l => `${l}\n`).join("")
    }))
    .map(arg => ({
      generated: "text_file",
      path: resolve(package_gen_dir, arg.gen_file_name),
      ...arg
    }));
  const gen_dir_args = gen_file_args.map(arg => ({
    generated: "dir",
    path: package_gen_dir,
    comment: `Contains file generated by custom-build script: '${arg.gen_file_name}'.`
  }));
  return [...gen_file_args, ...gen_dir_args];
}

function parseSourceLinkAttributes(entries, cmd) {
  const { cwd, target } = cmd;
  return entries
    .map(({ path, line }) => {
      const relPath = relative(cwd, path).replace(/\\/g, "/");
      const m = /^\s*#\[link\((.*)\)\]\s*$/.exec(line);
      if (!m) return;
      if (/wasm_import_module/.test(line)) return;
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
            "c++": ["x86_64-apple-darwin"],
            dbghelp: ["x86_64-pc-windows-msvc"],
            deno: [],
            errno_dragonfly: [],
            fdio: [],
            libcmt: [],
            libdeno: [],
            m: [],
            msvcrt: [],
            network: [],
            ole32: ["x86_64-pc-windows-msvc"],
            oleaut32: ["x86_64-pc-windows-msvc"],
            pthread: [],
            root: [],
            rt: [],
            rt: [],
            shlwapi: ["x86_64-pc-windows-msvc"],
            util: [],
            winmm: ["x86_64-pc-windows-msvc"],
            ws2_32: ["x86_64-pc-windows-msvc"],
            zircon: []
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
    [
      arg.rustflag || arg.source || arg.gen_file_name,
      arg.value,
      arg.comment || ""
    ].join("\0");
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
    let m = /^[\/\-]([^:]+)(?::(.*))?$/.exec(arg);
    if (m) {
      let [, libflag, value] = m;
      let output, path;
      switch (libflag.toUpperCase()) {
        case "OUT":
          output = "static_lib";
        // Fall through.
        case "DEF":
        case "LIST":
        case "LIBPATH":
        case "NAME":
        case "OUT":
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
      default:
        if (/^build-script-/.test(base.program)) {
          this.output_args = new Node(
            parseCargoDirectives(v.output_cargo_directives).values()
          );
          this.generated_files = new Node(
            parseGeneratedFiles(v.generated_files || {}, v).values()
          );
          break;
        }
        assert.fail(`Unknown tool: ${base.program}`);
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

    // Set target_name.
    if (base.program === "rustc") {
      const target_name = this.args
        .filter(a => a.rustflag === "--crate-name")
        .only("value", false);
      // Some rustc invocations are not a target, e.g. those that just extract
      // some info.
      if (!target_name || /^[_]+$/.test(target_name)) {
        this.not_a_target = true;
        return;
      }
      this.target_name = target_name;
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

    // Target type.
    if (base.program === "rustc") {
      const crate_type =
        this.args
          .filter(a => a.rustflag === "--crate-type")
          .only("value", false) || "bin";
      this.target_type = {
        bin: "rust_executable",
        lib: "rust_rlib",
        rlib: "rust_rlib",
        "proc-macro": "rust_proc_macro"
      }[crate_type];
      assert(this.target_type);
    } else {
      this.target_type = {
        rustc: "rust_crate",
        ar: "static_library",
        lib: "static_library",
        cc: "source_set",
        cl: "source_set"
      }[base.program];
    }
  }
}

function generate(trace_output) {
  const commands = new Node(Array.from(trace_output).values())
    .map(Command)
    .filter(c => !c.not_a_target)
    .map(Object.freeze);

  let outputRootDir = commands
    .map(cmd => cmd.output)
    .filter(Boolean)
    .map(dirname)
    .reduce((root, path) => {
      while (!path.startsWith(root)) root = root.slice(0, -1);
      return root;
    });

  const explicit_overrides = [];
  const invisible_overrides = [];
  for (const override of overrides) {
    if (override.invisible) {
      invisible_overrides.push(override);
    } else {
      explicit_overrides.push(override);
    }
  }

  let currentRecords;
  let recordOverrides = [];

  let override_baseline = { kind: null, baseline: true };
  for (let oi = 0; oi <= explicit_overrides.length; oi++) {
    console.log(
      `Applying overrides... ` + `${oi}/${explicit_overrides.length}`
    );

    const current_overrides = [
      override_baseline,
      ...invisible_overrides,
      ...explicit_overrides.slice(0, oi)
    ];

    let records = commands
      .groupBy({ key: "package_name" })
      .map(packageCommands => {
        let pkg_versions = packageCommands.groupBy({ key: "package_version" });
        // Apply canonical_version overrides.
        for (const override of current_overrides) {
          if (override.kind !== "canonical_version") continue;
          pkg_versions = pkg_versions
            .map(pkg_ver => override.run(pkg_ver) || [pkg_ver])
            .reduce(...flat);
        }
        // Now determine what the highest version number that appears in
        // `pkg_versions` is, and mark it as canonical.
        const canonical_version = pkg_versions.reduce((result, pkg_ver) =>
          semver.gt(pkg_ver.package_version, result.package_version)
            ? pkg_ver
            : result
        );
        return packageCommands.map(
          cmd =>
            new cmd.constructor(cmd, {
              package_version_is_canonical:
                cmd.package_version === canonical_version.package_version
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
        return target_commands
          .filter(cmd => !/^build-script-/.test(cmd.program))
          .filter(cmd => cmd.output)
          .joinBy(
            {
              key: "package_id",
              with: target_commands.filter(cmd =>
                /^build-script-/.test(cmd.program)
              )
            },
            (l, r) => {
              if (l.program !== "rustc" || !r) return l;
              return new Node(l, {
                args: mergeRustcArgs(l.args, r.output_args, r.generated_files)
              });
            }
          );
      })
      .map(target_commands => {
        // Add a default '--edition' arg to rust targets that don't have it.
        return target_commands.map(cmd => {
          if (
            cmd.program !== "rustc" ||
            cmd.args.filter(a => a.rustflag === "--edition").size > 0
          )
            return cmd;
          return new Node(cmd, {
            args: cmd.args.add({ rustflag: "--edition", value: "2015" })
          });
        });
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
        // Initialize dep-level overrides. This happens on every round and for
        // every target.
        for (const override of current_overrides) {
          if (override.kind !== "dep") continue;
          override.init && override.init(Array.from(target_commands));
        }

        // Find the command that builds the final output. Then work backwards and find
        // all deps.
        let outputMap = new Map(target_commands.map(cmd => [cmd.output, cmd]));
        let primary = target_commands.filter(
          cmd => cmd.env.CARGO_PRIMARY_PACKAGE
        );
        let alreadyIncluded = new Set();
        return primary.map(p => new Node(findDeps(p).values())).flat();

        function findDeps(cmd, alreadyIncluded = new Set()) {
          if (alreadyIncluded.has(cmd.output)) return [];
          alreadyIncluded.add(cmd.output);

          let depCommands = [];
          // Find rust deps.
          depCommands.push(
            ...cmd.args
              .filter(a => a.rustflag === "--extern")
              .map(a => {
                assert(outputMap.has(a.path));
                return new Node(outputMap.get(a.path), {
                  crate_alias: a.crate_alias
                });
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
              .map(dep => override.run(dep, cmd) || [dep])
              .reduce(...flat);
          }
          // Extract dep info that we need to keep associated with this cmd.
          let deps = depCommands.map(dep => ({
            dep_target_type: dep.target_type,
            dep_name: dep.package_name,
            dep_version: dep.package_version,
            dep_version_is_canonical: dep.package_version_is_canonical,
            dep_crate_alias: dep.crate_alias,
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
      // Now drop the primary packages themselves.
      .filter(cmd => !cmd.env.CARGO_PRIMARY_PACKAGE);

    class RustArg extends Node {
      init(items) {}
      get mapKey() {
        return JSON.stringify(this);
      }
    }

    records = records
      // Exclude deno and deno_core crates.
      .filter(record => !/^deno/.test(record.package_name))
      // Flatten all records to one arg per row.
      .map(record => {
        let {
          package_name,
          package_version,
          package_version_is_canonical,
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
              package_version_is_canonical,
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
      // Initialize the override. This happens again on every round.
      override.init && override.init(Array.from(records));
      // Apply the override.
      records = records
        .map(record => override.run(record) || [record])
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

  // Initialize file formatters.
  for (const f of file_formatters) {
    f.init && f.init();
  }

  // Normalize generated file contents and apply formatters.
  // Gather the results in a `path => content` associative table.
  let generated_files = [
    ...records
      .filter(rec => rec.generated === "text_file")
      .filter(rec => !rec.suppressed)
      // Apply specialized formatters.
      .map(rec => {
        for (const f of file_formatters) {
          const gen_file_content = f.run(rec, rec.gen_file_content);
          if (gen_file_content == null) continue;
          rec = new Node(rec, { gen_file_content });
        }
        return rec;
      })
  ].reduce((table, { path, gen_file_content }) => {
    if (!(path in table)) {
      table[path] = gen_file_content;
    } else {
      assert(table[path] === gen_file_content);
    }
    return table;
  }, {});

  // Build a list of package paths.
  let package_dirs = [
    ...records
      .filter(rec => !rec.suppressed)
      .map(rec => rec.package_dir)
      .filter(Boolean),
    ...records
      .filter(rec => !rec.suppressed)
      .filter(rec => rec.generated === "dir")
      .map(rec => rec.path)
  ].sort();

  // Remap paths.
  records = records.map(record => {
    let { path } = record;
    if (!path) return record;
    // Use forward slashes.
    path = path.replace(/\\/g, "/");
    // Replace root by a variable.
    path = path.replace(
      /(^.*(?=\/registry\/(?:src|gen)))|(^(.*\/)?third_party\/rust_crates(?=\/))/,
      "$cargo_home"
    );
    return new record.constructor(record, { path });
  });

  // Build the GN scope from the ground up.
  let root = new Root(records, Root.prototype.init);
  // Render the gn file.
  let build_gn_lines = root.write();
  let build_gn = [...build_gn_lines].map(l => `${l}\n`).join("");

  return { build_gn, generated_files, package_dirs };
}

// ===== Overrides =====

let replace_dep = (matcher, replacer) => {
  const get_lookup_key = target =>
    `${target.package_name}-${target.package_version}`;
  let replacements;

  return {
    kind: "dep",
    init(all_targets) {
      replacements = new Map();
      replacer.init(all_targets);
    },
    run(dependee, depender) {
      if (!matcher(dependee, depender)) {
        return;
      }

      let depender_key = get_lookup_key(depender);
      let dependee_key = get_lookup_key(dependee);

      let depender_replacements;
      if (replacements.has(depender_key)) {
        depender_replacements = replacements.get(depender_key);
      } else {
        depender_replacements = new Map();
        replacements.set(depender_key, depender_replacements);
      }

      let replacement;
      if (depender_replacements.has(dependee_key)) {
        replacement = depender_replacements.get(dependee_key);
      } else {
        const subst_target = replacer.run(dependee, depender);
        replacement =
          subst_target != null && get_lookup_key(subst_target) != dependee_key
            ? {
                depender,
                orig_dep: dependee,
                subst_dep: new Node(subst_target, {
                  crate_alias: dependee.crate_alias
                })
              }
            : null;
        depender_replacements.set(dependee_key, replacement);
      }

      return replacement && replacement.subst_dep;
    },
    comment(record) {
      let record_key = get_lookup_key(record);

      let depender_replacements = replacements.get(record_key);
      if (depender_replacements) {
        return [...depender_replacements.values()]
          .filter(Boolean)
          .map(({ orig_dep, subst_dep }) => {
            assert(orig_dep.target_name === subst_dep.target_name);
            return (
              `Override: ` +
              `use ${subst_dep.target_name} v${subst_dep.package_version} ` +
              `instead of v${orig_dep.package_version}.`
            );
          })
          .join("\n");
      }

      return replacer.comment(record);
    }
  };
};

let highest_version_of = matcher => {
  let subst_target;
  return {
    init(all_targets) {
      let candidate_targets = all_targets.filter(matcher);
      if (candidate_targets.length === 0) return;
      subst_target = candidate_targets.reduce((result, target) =>
        semver.gt(target.package_version, result.package_version)
          ? target
          : result
      );
    },
    run(dependee) {
      return subst_target;
    },
    comment(record) {
      const { target_name, package_version } = subst_target;
      return `Override: use ${target_name} v${package_version} instead.`;
    }
  };
};

let use_canonical_version = target_name =>
  replace_dep(
    t => t.target_name === target_name,
    highest_version_of(
      t => t.target_name === target_name && t.package_version_is_canonical
    )
  );

let remove_if = matcher => (...args) => (matcher(...args) ? [] : null);

let windows_only = target_name => [
  {
    kind: "dep",
    run: remove_if(
      dep => dep.target_name === target_name && !/windows/.test(dep.target)
    ),
    comment: `Override: '${target_name}' should be a windows-only dependency.`
  },
  {
    kind: "record",
    run: remove_if(
      record =>
        record.target_name === target_name &&
        !/windows/.test(record.target_triple)
    ),
    invisible: true
  }
];

let overrides = [
  ...windows_only("winapi"),
  ...windows_only("kernel32"),
  {
    kind: "canonical_version",
    run: remove_if(
      p => p.package_name === "rand" && semver.gte(p.package_version, "0.7.0")
    ),
    invisible: true
  },
  use_canonical_version("rand"),
  use_canonical_version("ansi_term"),
  use_canonical_version("log"),
  use_canonical_version("mime_guess"),
  use_canonical_version("proc_macro2"),
  use_canonical_version("quote"),
  use_canonical_version("scopeguard"),
  use_canonical_version("syn"),
  use_canonical_version("unicode_xid"),
  replace_dep(
    t => t.target_name === "rand_core",
    highest_version_of(
      t =>
        t.target_name === "rand_core" &&
        semver.gte(t.package_version, "0.3.0") &&
        semver.lt(t.package_version, "0.5.0")
    )
  ),
  {
    comment: "Override: avoid dependency on on 'owning_ref'.",
    kind: "dep",
    run: remove_if(dep => dep.package_name === "owning_ref")
  },
  {
    comment: "Override: avoid dependency on on 'owning_ref'.",
    kind: "record",
    run: remove_if(record =>
      Object.values(record).some(v => /owning[-_]ref/.test(v))
    )
  },
    ),
  },
  {
    comment: "Override: don't build 'ring-test' static library.",
    kind: "dep",
    run: remove_if(dep => dep.target_name === "ring-test")
  },
  {
    comment: `Suppress "warning: '_addcarry_u64' is not a recognized builtin."`,
    kind: "record",
    run(rec) {
      if (
        rec.target_name === "ring-core" &&
        /windows/.test(rec.target_triple) &&
        rec.libflag
      ) {
        let { output, value, path, libflag, ...meta } = rec;
        return [
          rec, // Insert -- don't replace.
          new rec.constructor({
            ...meta,
            cflag: "-Wno-ignored-pragma-intrinsic",
            force: true
          })
        ];
      }
    }
  },
  {
    comment: `Supress "warning: '_GNU_SOURCE' macro redefined."`,
    kind: "record",
    run(rec) {
      if (
        rec.target_name === "ring-core" &&
        /linux/.test(rec.target_triple) &&
        rec.arflag
      ) {
        let { output, value, path, libflag, ...meta } = rec;
        return [
          rec, // Insert -- don't replace.
          new rec.constructor({
            ...meta,
            cflag: "-Wno-macro-redefined",
            force: true
          })
        ];
      }
    }
  }
];

// ===== Generated file formatters =====

const line_ending_formatter = {
  run(_, content) {
    return content
      .replace(/[ \t\r]+\n/g, "\n") // Remove trailing whitespace.
      .replace(/\n{3,}/g, "\n\n") // Allow max. 2 consecutive newlines.
      .replace(/^\n+/, "") // Remove empty lines at start of file.
      .replace(/\n*$/, "\n"); // End the file with exactly one newline.
  }
};

const rustfmt_formatter = options => {
  const DEFAULT_OPTIONS = {
    force_explicit_abi: false,
    max_width: 80,
    tab_spaces: 4,
    hard_tabs: false,
    newline_style: "Unix",
    merge_derives: true,
    remove_nested_parens: true,
    use_field_init_shorthand: true,
    use_try_shorthand: true,
    reorder_imports: false,
    reorder_modules: false,
    use_small_heuristics: "Default"
  };
  const TEMP_DIR = resolve(WORK_DIR, "temp");

  let config_dir;
  return {
    init() {
      mkdir.sync(TEMP_DIR, { recursive: true });
      config_dir = mkdtemp.sync(`${TEMP_DIR}/rustfmt-config-`);
      const config_file = resolve(config_dir, "rustfmt.toml");
      writeFile.sync(
        config_file,
        Object.entries({ ...DEFAULT_OPTIONS, ...options })
          .map(([k, v]) => `${k} = ${JSON.stringify(v)}\n`)
          .join("")
      );
    },
    run(_, content) {
      const result = spawn.sync(
        "rustfmt",
        ["--config-path", config_dir, "--emit", "stdout"],
        { stdio: "pipe", input: content, encoding: "utf8" }
      );
      if (result.status !== 0) {
        throw new Error(result.stderr.trimRight() || "rustfmt failed");
      }
      return result.stdout;
    }
  };
};

const format_if = (matcher, formatter) => ({
  init() {
    formatter.init && formatter.init();
  },
  run(rec, content) {
    if (!matcher(rec)) {
      return;
    }
    return formatter.run(rec, content);
  }
});

const format_target_gen_file = (target_name, gen_file_name, formatter) =>
  format_if(
    (rec, _) =>
      rec.target_name === target_name && rec.gen_file_name === gen_file_name,
    formatter
  );

const file_formatters = [
  format_target_gen_file(
    "typenum",
    "consts.rs",
    rustfmt_formatter({ max_width: 10000, use_small_heuristics: "Off" })
  ),
  format_target_gen_file("mime_guess", "mime_types_generated.rs", {
    FORCE_LINE_BREAK: "// !FORCE_LINE_BREAK!",
    rustfmt: rustfmt_formatter({ max_width: 160, use_small_heuristics: "Off" }),
    init() {
      this.rustfmt.init();
    },
    run(rec, content) {
      content = content.replace(
        /(\,)\s*?([ \t]*\(UniCase)\b/g,
        `$1 ${this.FORCE_LINE_BREAK}\n$2`
      );
      content = this.rustfmt.run(rec, content);
      content = content.split(this.FORCE_LINE_BREAK).join("");
      return content;
    }
  }),
  line_ending_formatter
];
