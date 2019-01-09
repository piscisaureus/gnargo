const { mkdirSync, renameSync } = require("fs");
const { dirname, resolve, relative } = require("path");

const dirs = require(`${__dirname}/work/package_dirs.json`);

const cargo_home_src = `${__dirname}/work/cargo_home`;
const cargo_home_dst = `${__dirname}/work/rust_crates`;
//const cargo_home_dst = `d:/deno3/third_party/rust_crates`;

for (const src of dirs) {
  const rel = relative(cargo_home_src, src);
  const dst = resolve(cargo_home_dst, rel);
  const dst_parent = dirname(dst);

  mkdirSync(dst_parent, { recursive: true });
  renameSync(src, dst);
}
