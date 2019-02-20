copy %~dp0work\BUILD.gn d:\deno\build_extra\rust
move d:\deno\third_party\rust_crates %~dp0work\rust_crates_prev
move %~dp0work\rust_crates d:\deno\third_party
