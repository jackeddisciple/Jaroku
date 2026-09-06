# Vendored: the gloss character system

Everything in this directory, and `client/vendor/three.module.js`, is somebody else's code copied
into this repository unchanged. This file is the record of whose, from where, and what was altered
on the way in.

**Editing anything here restyles every agent in every workspace.** The recipes in `roster.ts` are
frozen so that an agent keeps its face; freezing them protects identity only while the code that
draws them is frozen too. Treat a change under `lib/gloss/` or `vendor/three.module.js` as a
breaking change to the product, not as a refactor.

## Source

| | |
|---|---|
| Repository | [albertobeiz/kindergrimm](https://github.com/albertobeiz/kindergrimm) |
| Commit | `5857b1e1cae2713d6714ad7dd7f89626bb242f0f` |
| Commit date | 2026-08-24 |
| Licence | [The Unlicense](https://unlicense.org) — public domain: copy, modify, publish, sell, commercial use, no attribution required |
| Taken on | 2026-09-06 |
| Vendored in | v0.3.14 |

The commit is not a guess. The local checkout the files came from was an archive with no `.git`,
so every file below was hashed with `git hash-object` and matched against the upstream trees over
the GitHub API; `5857b1e1` is the commit whose tree holds all twenty-six blobs byte for byte.

Attribution is **not** legally required under the Unlicense. It is recorded anyway, because in a
year nobody will remember where 280 KB of character-rigging code came from, and a file with no
origin is a file nobody dares touch and nobody dares delete.

## What was taken

Twenty-five source files, plus Three.js.

Seven of them are what the work actually calls:

| File | Exports used | Why |
|---|---|---|
| `grig.js` | `buildGloss`, `ensureGParams`, `newGRecipe`, `BODY_IDS`, `STANCE_IDS` | recipe → bones → meshes |
| `gform.js` | `formSurface`, `FORM_MESHES` | cage → subdivided surface |
| `catmullClark.js` | `subdivideN` | subdivision; `gform` depends on it |
| `gmedia.js` | `studioEnv`, `MATERIALS`, `MATERIAL_IDS`, `makeMaterialFactory`, `dressScene` | the gloss look. The Material axis |
| `gpalette.js` | `PALETTES`, `PALETTE_IDS`, `HAIR_COLORS`, `tint`, `pickOutfit` | the Palette axis |
| `gspecies.js` | `GSPECIES`, `pickGBody`, `pickGStance`, `gcastingFor` | the Humanoid / Body / Stance axes |
| `gface.js` | `createGlossFace`, `GLOSS_FACES` | all animation: blink, gaze, saccade, sway, breath, idle |

The other eighteen are the **import closure**, and they are here because without them the seven
above do not run. `grig.js` alone imports `gshape.js`, `glayout.js`, `gtexture.js`, `rng.js` and
the whole `gparts/` registry; `glayout.js` reaches `ghair.js`. The specification's table listed the
export surface, which is a different thing from the dependency graph:

```
gshape.js  glayout.js  ghair.js  gtexture.js  rng.js
gparts/{index,body,frame,crest,hair,eyes,brows,nose,mouth,blush,specs,hat,mark}.js
```

`rng.js` came from `src/rng.js` upstream — one level above `src/gloss/` — and sits here instead,
because a single-file `lib/` beside a directory of its only consumer is a directory nobody finds.
It is Mulberry32 plus FNV-1a, and the FNV-1a is, by coincidence rather than by arrangement, the
same hash `server/src/agents/emojiPalette.ts` spells for the emoji assignment.

`client/vendor/three.module.js` is Three.js as upstream pinned it. **Do not swap it for the npm
package.** The pinned file is part of the freeze: a minor version of Three.js that changes a
default on `MeshPhysicalMaterial` changes what every avatar looks like, and nothing in a lockfile
would say so. `test:gloss-vendor` fails if `three` appears in `client/package.json`.

## What was deliberately not taken

| File | Why not |
|---|---|
| `src/gloss/gcrowd.js` | The page harness — 7×5 grid maths, cream sheet, HUD, filter bar, `R` = new sheet, tap-to-reroll. None of it survives. It was read end to end as the reference for how the parts wire together, and `GlossStage.ts` is written against that reading rather than copied from it. |
| `src/gloss/gloss.js` | The editor page's harness. Same reason. |
| `src/anim.js`, `src/sketch.js`, `src/parts/*`, `src/media.js` | The 2D doodle pipeline. A different product; the gloss path does not import it. |
| `assets/music/*`, `game.js`, everything else | 4 MB of mp3 and a game. |

## Every modification made during extraction

Seven lines, in five files. Nothing else was touched — no reformatting, no lint pass, no comment
edits, so a `diff` against upstream is exactly this list and stays readable.

| File | Line | Was | Is |
|---|---|---|---|
| `grig.js` | 23 | `from 'three'` | `from '../../../vendor/three.module.js'` |
| `grig.js` | 24 | `from '../rng.js'` | `from './rng.js'` |
| `gmedia.js` | 13 | `from 'three'` | `from '../../../vendor/three.module.js'` |
| `gshape.js` | 24 | `from 'three'` | `from '../../../vendor/three.module.js'` |
| `gtexture.js` | 32 | `from 'three'` | `from '../../../vendor/three.module.js'` |
| `gtexture.js` | 33 | `from '../rng.js'` | `from './rng.js'` |
| `gface.js` | 27 | `from 'three'` | `from '../../../vendor/three.module.js'` |

The specifier was rewritten rather than aliased in the bundler. Upstream resolves the bare `three`
through an import map in its HTML; this repository has no vendored code and therefore no
convention to match, and the three things that load these files — Vite, `tsc`, and `tsx` running
the suites — would each need their own alias entry. A path in the file is one fact in one place,
and it is the fact a reader of `grig.js` needs anyway.

The `.d.ts` files beside the sources are **not** upstream. They are hand-written declarations of
the export surface TypeScript call sites use, added because this package has `allowJs` off; they
describe the vendored code and never change it.

## Where the rest of the record lives

| | |
|---|---|
| The characters, as a picture | [`docs/avatars/roster.png`](../../../../docs/avatars/roster.png), and [`docs/avatars/README.md`](../../../../docs/avatars/README.md) for how to change the list |
| Why twenty-eight, why twelve, why any of this | [`docs/avatars/decisions.md`](../../../../docs/avatars/decisions.md) — §10's D1–D4 |
| What shipped | `CHANGELOG.md`, v0.3.14 |

## Reproducing the extraction

```sh
git clone https://github.com/albertobeiz/kindergrimm && cd kindergrimm
git checkout 5857b1e1cae2713d6714ad7dd7f89626bb242f0f
```

Then copy the twenty-five files listed above into `client/src/lib/gloss/`, `src/rng.js` alongside
them, `vendor/three.module.js` into `client/vendor/`, and apply the seven-line table.
