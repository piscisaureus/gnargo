copy %~dp0work\BUILD.gn d:\deno2\build_extra\rust
move d:\deno2\third_party\rust_crates %~dp0work\rust_crates_prev
move %~dp0work\rust_crates d:\deno2\third_party
