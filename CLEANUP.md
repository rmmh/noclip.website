# GoldenEye 007 cleanup plan

The committed whole-game renderer baseline is `74a9254116f11035`. It covers
all 33 GoldenEye scenes over two runs and ten samples per scene, with portal
and frustum culling forcibly disabled. Behavior-preserving cleanup must retain
that hash; intentional rendering changes belong in separate commits with an
explicit baseline update.

1. Make the whole-game hash an enforced regression expectation rather than a
   value copied from terminal output.
2. Define the CRG1 archive schema once and share it between extraction and
   rendering.
3. Split the GoldenEye scene monolith into display-list, model, visibility,
   effects, renderer, and scene-catalog responsibilities.
4. Split ROM extraction into background, setup, model, environment, and
   texture modules.
5. Move the GoldenEye renderer extensions out of `Glover/render.ts` and into
   `GoldenEye007/render.ts`. Keep only genuinely shared N64 facilities in shared
   code, and keep GoldenEye lighting, animation, ordering, and state policy in
   the GoldenEye module.
6. Replace setup types, model-node opcodes, Fast3D commands, flags, attachment
   slots, and monitor commands with traced named constants. Remove debugging
   narration and retain comments that document cartridge behavior.
7. Decompose the regression harness into CLI, local-server, browser/CDP,
   sampling, and hashing components shared with the screenshot tool. Regression
   culling remains unconditionally disabled.
8. Finish with builds, the complete 33-scene hash gate, focused
   Archives/Frigate/MP Archives checks, and a `git diff main` audit.

The current cleanup pass covers items 1–3, 5–7, and the corresponding item-8
verification. Extractor decomposition in item 4 is deliberately deferred.

## Completed in this pass

- The whole-game hash is enforced for unfiltered `ge007` runs.
- Renderer and extractor consume one archive schema from `archive.ts`.
- Display-list/model decoding, environmental effects, prop placement, and
  GoldenEye draw-call rendering now have dedicated modules. Small STAN,
  texture-cache, and catalog helpers remain with scene orchestration.
- Glover's renderer is restored to `main`; GoldenEye-specific rendering policy
  lives in `GoldenEye007/render.ts`.
- Traced setup, model-node, Fast3D, monitor, flag, and attachment values have
  named constants.
- Regression and screenshot tooling share port, HTTP-wait, and CDP code;
  regression CLI/baselines, process lifecycle, browser sampling, and renderer
  hashing are separate modules. Regression culling remains unconditionally
  disabled.
- The final build and complete 33-scene, two-run gate pass with
  `74a9254116f11035`.
