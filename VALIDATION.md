# Game-Only Export Validation

## Dialog And Warehouse Regression Validation (2026-11-26)

- Windows, Node.js 26.13.1: all 93 existing browser-interface assertions and 67 Node tests/subtests passed. The 11 added tests/subtests cover dialog naming, keyboard focus containment/restoration, settlement dismissal protection, logout cleanup, stale warehouse success/failure responses, concurrent reads, escaped warehouse fields and safe activation bindings.
- Python 3.12.14: all 19 preview/release tests passed. The release source scan passed for 148 files with four previously reviewed synthetic fixture matches; the original maintainer's private marker list was unavailable, so no private deployment markers were checked.
- Chrome with local API fixtures: checked character dialogs at desktop (1440×900), phone (375×812) and landscape (812×375 and 568×320) sizes, including scrolling to the final controls, focus cycling/restoration, reduced motion and dismissed warehouse requests. No browser runtime errors occurred. These fixtures do not provide playable preview accounts or backend validation.
- Test processes ran serially with affinity `0F` on an eight-CPU machine. Dependencies, temporary files and screenshots stayed in ignored project-local directories. Original source line endings were preserved so unchanged fixture hashes remain valid.
- Updated the reviewed test-file hash after inspecting the changes; all existing authentication fixtures remain synthetic.
- The Impeccable static detector reported existing contrast, text-size and decoration warnings elsewhere in the interface. This focused dialog change does not claim a complete visual/accessibility audit of the game; character-detail contrast regression tests passed.

The initial export validation below is retained as historical context.

Validation date: 2026-11-25. This export contains only the card game; no complete host application or production deployment is included.

## Checks Actually Run

- Windows, Node.js 24.22.3: 93 browser-interface assertions passed.
- Node's test runner: 56 tests/subtests passed, zero failed, covering browser login gates, server-owned state, intent-only requests, expiry/settlement, readability and retained upstream attribution.
- Python 3.13.2: 19 preview/release tests passed, including anonymous gameplay rejection, no local wallet writes, static-source/environment/data blocking, path traversal, Host/Origin checks, private-marker rejection, complete-host exclusion and ZIP hash manifests.
- Python/JSON syntax checks, shared CPU-wrapper shell syntax and game-only CI YAML/boundaries passed. The public CI workflow was inspected locally, not claimed to have run on GitHub.
- The release source audit checked 148 selected game files against 14 known private deployment markers. Four synthetic fixture matches are retained by exact hash across three reviewed files; credential values are not recorded in the review manifest.

Local browser test processes were started serially with affinity `0F` on an eight-CPU machine, limiting their process tree to four CPUs. Node used one V8 pool worker and sequential test-file execution. No production build or service CPU setting was changed.

## Game And Host Boundary

The 14 game backend source/catalog/test files are byte-identical to the previously validated game implementation. Earlier full-host validation exercised the game using real SQLite, MySQL and PostgreSQL; the full host, its images and broader platform tests are intentionally not distributed in this game-only package.

This export did **not** build or run a standalone Go game server. The existing Go integration requires the host session, wallet, cache and database contracts in `backend/INTEGRATION.md`. Browser mocks, a source scan and matching hashes are not a substitute for validating an adapter to a different host.

The original local game files retain their recorded hashes. The earlier oversized full-site export was preserved privately instead of deleting its changes. This correction used local files only and did not connect to or modify production services.

## Publication And Artwork

The generated source ZIP includes a per-file SHA-256 manifest and excludes host-platform code, production connections, environment/data files, logs, backups, installed dependencies and Git history. Known private markers are held outside the game-source directory and are not packaged.

The game's 28 character provenance entries and 95 WebP files are retained. Artwork permission remains a separate question documented in `ASSETS.md`; source validation does not certify an unconfirmed image license. At the 2026-11-25 validation snapshot, no public repository had been uploaded. Publishing this source does not deploy a production service. GitHub Actions results are reported by the workflow itself, not by the earlier local validation snapshot.
