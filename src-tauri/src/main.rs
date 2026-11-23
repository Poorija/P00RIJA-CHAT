// P00RIJA Chat — end-to-end encrypted messenger.
// Copyright (C) 2026 Poorija <p00rija@tutamail.com>
//
// Licensed under the GNU Affero General Public License, version 3 only.
// See LICENSE for the full text. Section 13 matters here: run a modified
// version as a network service and its users are entitled to your source.

// A GUI build must not also open a console. Without this attribute the
// linker produces a console-subsystem PE and Windows puts a black cmd
// window behind the app window for as long as it runs. It is scoped to
// release so that `println!` debugging still reaches a terminal in a
// debug build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    p00rija_chat_lib::run();
}
