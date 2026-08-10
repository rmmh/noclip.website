<img align="right" src="src/assets/logo.svg" width="128" height="128">

# <a href="https://mod.ifies.com/twoclip/">twoclip</a>

A fork of [noclip](https://noclip.website) with additional games I didn't bother upstreaming, particularly N64.

Major differences compared to upstream:

* Nintendo 64
  * GoldenEye 007 (new)
  * Super Mario 64 (new)
  * Donkey Kong 64 (significantly expanded)
* Nintendo DS
  * Metroid Prime Hunters (significantly expanded)

The reverse engineering of model formats was done by many people. See the application for full credits.

## Contributing

You should probably contribute to upstream instead.

## Development Guide

To develop for twoclip, you'll need these requisites:

* Your code editor of choice (for example, [Visual Studio Code](https://code.visualstudio.com/), [WebStorm](https://www.jetbrains.com/webstorm/)),
* [Node.js](https://nodejs.org/en/download). Choose the latest LTS version and choose the `pnpm` package manager,
* [rustup](https://rust-lang.org/learn/get-started/).

Then, use the following commands to set up your environment (only needed every so often):
* Install dependencies from npm: `pnpm install`,
* Set up the required rust binaries:
  ```shell
  rustup target add wasm32-unknown-unknown
  cd rust
  cargo install cargo-run-bin
  cargo bin --install
  ```

Finally, to build and run the project, use `pnpm start`. This will start a live-reloading environment and uses filesystem watchers to auto-build the project. To include live-reloading for Rust code as well, use `pnpm start --watch`.

The dev server serves the site from the root of the server. To serve it from a subdirectory instead, set `BASE_PATH`, e.g. `BASE_PATH=/twoclip pnpm start`. Production builds (`pnpm build`) reference their assets relatively, so the `dist` directory can be dropped into any directory of a static host without further configuration.

Rust is built in release mode by default. To run with a faster-to-build debug WASM module instead, use `npm run start:debug`.

## Controls

Key | Description
-|-
`Z` | Show/hide all UI
`T` | Open "Games" list
`W`/`A`/`S`/`D` or Arrow Keys | Move camera
Hold `Shift` | Make camera move faster
Hold `\` | Make camera move slower
`E` or `Page Up` or `Space` | Move camera up
`Q` or `Page Down` or `Ctrl+Space` | Move camera down
`Scroll Wheel` | Adjust camera movement speed (in WASD camera mode; instead changes the zoom level in Orbit or Ortho camera modes)
`I`/`J`/`K`/`L` | Tilt camera
`O` | Rotate camera clockwise
`U` | Rotate camera counterclockwise
`X` | in WASD camera mode; enables "Hover Mode", locking changes to the y axis to the "Move camera up/down" controls
`1`/`2`/`3`/`4`/`5`/`6`/`7`/`8`/`9` | Load savestate
`Shift`+`1`/`2`/`3`/`4`/`5`/`6`/`7`/`8`/`9` | Save savestate
`Numpad 3` | Export save states
`.` | Freeze/unfreeze time
`,` | Hold to slowly move through time
`F9` | Reload current scene
`B` | Reset camera position back to origin
`R` | Start/stop automatic orbiting (requries Orbit or Ortho camera modes)
`Numpad 5` | Immediately stop all orbiting (requries Orbit or Ortho camera modes)
`Numpad 2`/`Numpad 4`/`Numpad 6`/`Numpad 8` | Snap view to front/left/right/top view (requires Orbit camera mode)
`F` | Not sure what this key does, let me know if you figure it out

## Third-Party Credits

All icons you see are from [The Noun Project](https://thenounproject.com/), used under Creative Commons CC-BY:
* Truncated Pyramid by Bohdan Burmich
* Images by Creative Stall
* Help by Gregor Cresnar
* Open by Landan Lloyd
* Nightshift by mikicon
* Layer by Chameleon Design
* Sand Clock by James
* Line Chart by Shastry
* Search by Alain W.
* Save by Prime Icons
* Overlap by Zach Bogart
* VR by Fauzan Adaiima
* Play Clapboard by Yoyon Pujiyono
* Undo by Numero Uno
* Redo by Numero Uno
* Zoom In by Tanvir Islam
* Zoom Out by Tanvir Islam
