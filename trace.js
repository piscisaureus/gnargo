"use strict";

const assert = require("assert");
const { writeFileSync, linkSync, renameSync, createReadStream } = require("fs");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { createServer } = require("net");
const { basename, dirname, extname, resolve, relative } = require("path");
const { writeFile, execFile, mkdir, mkdtemp } = require("./lib/async");
const { exeSuffix, main, walkDir, iterLines } = require("./lib/util");

const SRC_DIR = "d:/deno2";
const WORK_DIR = `${__dirname}/work`;

let TARGETS = [
  "x86_64-pc-windows-msvc",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu"
  //"x86_64-unknown-freebsd",
  //"x86_64-linux-android"
];

const cargo_home_dir = have_dir(WORK_DIR, "cargo_home");
const temp_base_dir = have_dir(WORK_DIR, "temp");

const temp_dir = resolve(mkdtemp.sync(`${temp_base_dir}/`));
const shim_dir = have_dir(temp_dir, "shim");

let manifest_path = resolve(SRC_DIR, "Cargo.toml");
let base_env = {
  ...keysToUpperCase(process.env),
  CARGO_HOME: cargo_home_dir
};

main(async () => {
  await cargoFetch();

  let commands = [];
  for (const target of TARGETS) {
    // It's easy to do this in parallel but cargo already parallelizes pretty well.
    commands.push(...(await traceTargetBuild(target)));
  }

  let commands_json = resolve(WORK_DIR, "commands.json");
  await writeFile(commands_json, JSON.stringify(commands, null, 2));
  console.log(`Done tracing Cargo build. ${commands_json}`);

  await execFile(process.execPath, [`${__dirname}/gen.js`], {
    stdio: "inherit"
  });
});

async function cargoFetch() {
  // TODO: figure out how to do `stdio: "inherit"` with async execFile.
  execFileSync(
    "cargo",
    ["fetch", "--locked", "--manifest-path", manifest_path],
    {
      cwd: temp_dir,
      env: base_env,
      stdio: "inherit"
    }
  );
}

async function traceTargetBuild(target) {
  const cargo_target_dir = have_dir(temp_dir, `target_${target}`);

  console.log(`TARGET: ${target}`);
  console.log(`WORK_DIR: ${WORK_DIR}`);
  console.log(`CARGO_HOME: ${cargo_home_dir}`);
  console.log(`CARGO_TARGET_DIR: ${cargo_target_dir}`);

  let shimServer = await shimHost();
  let port = shimServer.address().port;

  let target_is_win = /windows/.test(target);
  let target_env = {
    ...base_env,
    CARGO_TARGET_DIR: cargo_target_dir
  };
  let shim_env = {
    ...target_env,
    SHIM_PORT: `${port}`,
    RUSTC: writeShim(`${shim_dir}/rustc${exeSuffix}`, true),
    RUSTC_WRAPPER: ""
  };

  if (target_is_win) {
    writeShim(`${shim_dir}/cl${exeSuffix}`);
    writeShim(`${shim_dir}/lib${exeSuffix}`);
    shim_env = {
      ...shim_env,
      VCINSTALLDIR: shim_dir,
      PATH: `${shim_dir};${shim_env.PATH}`
    };
  } else {
    shim_env = {
      ...shim_env,
      CC: writeShim(`${shim_dir}/cc${exeSuffix}`),
      AR: writeShim(`${shim_dir}/ar${exeSuffix}`)
    };
  }

  const commands = [];

  let cargo = spawn(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      target,
      "--manifest-path",
      manifest_path
    ],
    { cwd: temp_dir, env: shim_env, stdio: "inherit" }
  );

  let code = await new Promise(res => cargo.on("close", res));
  if (code !== 0) {
    throw new Error("Cargo failed");
  }

  shimServer.close();
  return commands;

  async function* lines(stream) {
    stream.setEncoding("utf8");
    let buf = "";
    for await (const chunk of stream) {
      buf += chunk;
      let lines = buf.split(/\r?\n/);
      buf = lines.pop();
      yield* lines;
    }
    if (buf) yield buf;
  }

  async function buffer_lines(stream) {
    const r = [];
    for await (const line of lines(stream)) {
      r.push(line);
    }
    return r;
  }

  async function spawn_lines(exe, args = [], { input, ...options } = {}) {
    let proc = spawn(exe, args, { stdio: "pipe", ...options });
    if (input) {
      proc.stdin.end(input.join("\n"));
    }
    [proc.stdout, proc.stderr] = await Promise.all([
      buffer_lines(proc.stdout),
      buffer_lines(proc.stderr),
      new Promise(res => proc.on("close", res))
    ]);
    assert(proc.exitCode != null);
    return proc;
  }

  async function fwd(prefix, source, ...sinks) {
    if (source.setEncoding) {
      source = lines(source);
    }
    for await (const line of source) {
      for (const sink of sinks) {
        sink.write(`${prefix} ${line}\n`);
      }
    }
  }

  function split2(s, delim) {
    let i = s.indexOf(delim);
    return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
  }

  async function shimHost() {
    let server = createServer(async conn => {
      let args = [],
        cwd,
        exe,
        env = Object.create(null),
        input = [];
      for await (const line of lines(conn)) {
        let [cmd, payload] = split2(line, " ");
        switch (cmd) {
          case "cwd":
            cwd = payload;
            break;
          case "exe":
            exe = payload;
            break;
          case "arg":
            args.push(payload);
            break;
          case "env": {
            let [k, v] = split2(payload, "=");
            env[k] = v;
            break;
          }
          case "in":
            input.push(payload);
            break;
          case "end":
            return await tool({ conn, args, cwd, exe, env, input });
          default:
            throw new Error("WUT? " + line);
        }
      }
    }).listen(0, "127.0.0.1");
    await new Promise(res => server.once("listening", res));
    return server;
  }

  async function tool({ conn, args, cwd, exe, env, input }) {
    const program = basename(exe, exeSuffix);
    if (args[0] === exe) {
      args.shift();
    } // Not sure what causes this.
    for (const key in { ...shim_env, ...env }) {
      if (shim_env[key] === env[key]) delete env[key];
    }

    let command = { program, exe, cwd, args, target, env, input };

    let proc;
    switch (program) {
      case "rustc":
        proc = await rustc(command);
        break;
      case "lib":
      case "cl":
      case "cc":
      case "ar":
        proc = await cTool(command);
        break;
      case "build-script-build":
        proc = await customBuild(command);
        break;
    }

    if (proc) {
      assert(proc.exitCode != null); // program must wait for it!
      fwd("out", proc.stdout, conn /*process.stdout*/);
      fwd("err", proc.stderr, conn /*process.stdout*/);
      // Race condition in Cargo!
      await new Promise(res => setTimeout(res, 10));
      conn.write(`ret ${proc.exitCode}\n`);
    } else {
      conn.end("ret 0\n");
    }

    if (command.input.length === 0) {
      delete command.input;
    }
    commands.push(command);
  }

  async function customBuild(command) {
    let { cwd, args, exe, env } = command;
    if (/^deno/.test(env.CARGO_PKG_NAME)) {
      command.output_cargo_directives = [];
      return; // Don't run Deno's own custom build script.
    }
    let realExe = resolve(
      cwd,
      dirname(exe),
      `real-build-script-build${exeSuffix}`
    );
    let proc = await spawn_lines(realExe, args, {
      cwd,
      env: { ...env, ...shim_env }
    });
    command.output_cargo_directives = proc.stdout.filter(l =>
      /^cargo:/.test(l)
    );
    return proc;
  }

  function cTool(command) {
    const { program, cwd, args } = command;
    for (const arg of args) {
      let m =
        (program === "lib" && /^\/OUT:(.*)$/.exec(arg)) ||
        (program === "cl" && /^\/Fo(.*)$/.exec(arg)) ||
        (program === "cc" && /^\-o(.*)$/.exec(arg));
      program === "ar" && /^(.*\.a)$/.exec(arg);
      if (m) {
        let filename = resolve(cwd, m[1]);
        writeFileSync(filename, "");
      }
    }
  }

  async function rustc(command) {
    let { cwd, args, input } = command;
    let real_env = { ...target_env, ...command.env };

    let crate_name, out_dir, target, meta;
    for (const [i, arg] of args.entries()) {
      let next = args[i + 1];
      if (
        arg === "-vV" ||
        arg === "-V" ||
        arg === "--version" ||
        arg === "___"
      ) {
        meta = true;
      } else if (arg === "--out-dir") {
        out_dir = next;
      } else if (arg === "--crate-name") {
        crate_name = next;
      } else if (arg === "--target") {
        target = next;
      }
    }

    let proc;
    let file_names;

    if (!meta) {
      proc = await spawn_lines("rustc", [...args, "--print=file-names"], {
        cwd,
        env: real_env,
        input
      });
      if (proc.exitCode !== 0) return proc;
      file_names = proc.stdout.filter(Boolean);
      command.outputs = file_names.map(f => resolve(cwd, out_dir || ".", f));
    }

    if (!target || meta || crate_name === "build_script_build") {
      proc = await spawn_lines("rustc", args, { cwd, env: real_env, input });
      if (proc.exitCode !== 0) return proc;
    } else {
      file_names.forEach(writeFakeDepFile);
    }

    if (target) {
      const list = (command.source_file_link_attributes = []);
      for await (const entry of walkDir(cwd)) {
        const ext = extname(entry.name);
        if (ext !== ".rs") continue;
        const stream = createReadStream(entry.path, { encoding: "utf8" });
        nextLine: for await (const line of iterLines(stream)) {
          if (!/^\s*#\[link\s*\(/.exec(line)) continue;
          list.push({ path: entry.path, line });
        }
      }
    }

    if (crate_name === "build_script_build") {
      // Rename build-script-build executable.
      assert.strictEqual(file_names.length, 1);
      let f1 = resolve(cwd, out_dir, file_names[0]),
        dir = dirname(f1),
        ext = extname(f1);
      let f2 = resolve(dir, `real-build-script-build${ext}`);
      renameSync(f1, f2);
      // Place a shim over the original.
      writeShim(f1);
    }

    return proc;

    function writeFakeDepFile(outfile) {
      let m =
        /^lib(.*)\.rlib$/.exec(outfile) || /^([^\.]*)(?:\.exe)?$/.exec(outfile);
      if (!m) {
        console.error(`Could not figure out depfile name: ${outfile}`);
        return;
      }
      let depfile = resolve(cwd, out_dir, `${m[1]}.d`);
      writeFileSync(depfile, `${depfile}: dummy.rs\n`);
    }
  }
}

function keysToUpperCase(env) {
  return Object.entries(env).reduce(
    (env, [k, v]) => ({ ...env, [k.toUpperCase()]: v }),
    Object.create(null)
  );
}

function have_dir(...parts) {
  const dir = resolve(...parts);
  mkdir.sync(dir, { recursive: true });
  return dir;
}

const didCompile = new Set();
function compileShim(readStdin = false) {
  const exe = resolve(shim_dir, `shim_${+readStdin}${exeSuffix}`);

  if (!didCompile.has(exe)) {
    execFileSync(
      "rustc",
      [resolve(__dirname, "shim.rs"), `--emit=link=${exe}`],
      {
        stdio: "inherit",
        cwd: temp_dir,
        env: {
          ...keysToUpperCase(process.env),
          SHIM_READ_STDIN: Number(readStdin)
        }
      }
    );
    didCompile.add(exe);
  }

  return exe;
}

const didLink = new Set();
function writeShim(exe, readStdin = false) {
  exe = resolve(exe);

  if (!didLink.has(exe)) {
    const cache_exe = compileShim(readStdin);
    linkSync(cache_exe, exe);
    didLink.add(exe);
  }

  return exe;
}
