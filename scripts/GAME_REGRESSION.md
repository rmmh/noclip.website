# Game regression harness

The harness discovers the selected game's visible scenes from noclip's runtime
scene database, loads every scene, and samples ten deterministic times in two
independent runs. A scene which never reaches its renderer, throws in the
browser, or misses the timeout is recorded as an error.

```sh
node scripts/game_regression.mjs --game ge007 --output ge007-regression.jsonl
```

`--scene ID` selects one scene. `--screenshot [directory]` hashes the final PNG
output to detect renderer changes and optionally retains the first run's
captures. DK64 also has a low-level adapter which hashes its RDP state, decoded
textures, mesh buffers, animation matrices, and renderer instances. Other games
use the generic load/render probe and screenshot hashes until an adapter is
added.

Regression runs always disable culling so a fixed camera cannot hide a broken
level section. The harness temporarily forces shared camera-frustum tests to
pass and clears DK64's cached mesh/sprite bounds. Portal disabling is passed
through `SceneGfx.setRegressionOptions`; GoldenEye honors it at the room
visibility traversal boundary. The fixed mode is recorded in the overall JSONL
record.

The original DK64 command remains available through
`scripts/dk64_rdp_regression.mjs`.
