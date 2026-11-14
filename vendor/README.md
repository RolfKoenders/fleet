# vendor

`js-yaml.mjs` is `dist/js-yaml.mjs` from js-yaml 5.5.0 (MIT, see `js-yaml.LICENSE`), copied unchanged from the npm tarball. It is the one fleet reads config with; `yaml/` below is only used to splice edits.

| | |
|---|---|
| version | 5.5.0 |
| sha256 | 213470960d9c2ff1d01f9164e5017749bfc383d8a6ebb8683f35c76e8c6d052b |

A test checks the hash, so updating means replacing the file and this table together.

## yaml

`yaml/` is the ESM build of yaml 2.9.1 (ISC, see `yaml/LICENSE`; eemeli/yaml, no dependencies): `browser/index.js` and `browser/dist/` from the npm tarball, copied unchanged to `yaml/index.js` and `yaml/dist/`, JavaScript only. `yaml/index.d.ts` is fleet's own, a minimal declaration of what fleet calls, like `js-yaml.d.mts`.

Fleet uses it only to find where nodes sit in a config file (their `range`), so an edit can splice the one span it changes. It never prints a file with it.

| | |
|---|---|
| version | 2.9.1 |
| tree sha256 | 63433941a7ea200f8cd05b5cb4c42b11f0dc1368b82f8546109a1143b70abc57 |

The tree hash is the sha256 of one line per `.js` file under `yaml/`, sorted by path, each `<path> <sha256 of the file>\n`. A test checks it. To update:

1. `npm pack yaml@<version>` in a temp directory and unpack it.
2. Replace `yaml/index.js`, `yaml/dist/` and `yaml/LICENSE` with `browser/index.js`, `browser/dist/` (keep only the `.js` files) and `LICENSE`.
3. Recompute the hash with `treeHash` in `test/repo.test.ts` (the test prints both on a mismatch) and set it and the version above.
4. Run `npm run typecheck` and `npm test`; `test/edit.test.ts` exercises the parts fleet reads.
