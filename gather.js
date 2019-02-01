const {
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  existsSync,
  writeFileSync
} = require("fs");
const { dirname, resolve, relative } = require("path");

const dirs = require(`${__dirname}/work/package_dirs.json`);

const cargo_home_src = `${__dirname}/work/cargo_home`;
const cargo_home_dst = `${__dirname}/work/rust_crates`;

for (const src of dirs) {
  const rel = relative(cargo_home_src, src);
  const dst = resolve(cargo_home_dst, rel);
  const dst_parent = dirname(dst);

  mkdirSync(dst_parent, { recursive: true });
  renameSync(src, dst);
}

const maybe_ignore = [""];
const ignore = [];
for (const base_path of maybe_ignore) {
  const is_dir = statSync(`${cargo_home_src}${base_path}`).isDirectory();
  const exists = existsSync(`${cargo_home_dst}${base_path}`);
  if (exists) {
    if (is_dir) {
      maybe_ignore.push(
        ...readdirSync(`${cargo_home_src}${base_path}`).map(
          name => `${base_path}/${name}`
        )
      );
    }
  } else {
    ignore.push(base_path + (is_dir ? "/" : ""));
  }
}
writeFileSync(
  `${cargo_home_dst}/.gitignore`,
  ignore
    .sort()
    .map(l => `${l}\n`)
    .join("")
);
