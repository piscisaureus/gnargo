const { promisify } = require("util");
const imports = { ...require("child_process"), ...require("fs") };

function asyncify(fn, name = fn.name) {
  fn = promisify(fn);
  return {
    [name]: async function(...args) {
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i].then === "function") {
          args[i] = await args[i];
        }
      }
      return fn.call(this, ...args);
    }
  }[name];
}

for (const name in imports) {
  let fn = imports[name],
    syncFn = imports[`${name}Sync`];
  if (typeof fn === "function" && typeof syncFn === "function") {
    fn = asyncify(fn, name);
    fn.sync = syncFn;
    exports[name] = fn;
  }
}
