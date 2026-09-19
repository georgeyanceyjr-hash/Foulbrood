# Building the viewer

Source for the Hive viewer, including the Windows compatibility changes.

## Contents

- `ui/`: interface, local Python service, engine integration, analysis and game review, import/export, native launchers and packaging scripts.
- `ui/vendor/visual_hive/`: Analytic notation converter.
- `src/`: Rust rules library and helper programs required by the viewer. Search-related modules are present because the shared library references them; these are the viewer's supporting source snapshot.
- `tests/` and `ui/test_*`: regression tests. The JSON under `docs/` is a fixture used by a test.
- `LICENSE`: license terms. Third-party notices are retained.

## Run from source

Requirements: Rust with Cargo, Python 3.9 or newer, and a modern browser.
Run commands from this directory:

```
cargo build --release --bin board_view
python3 ui/server.py
```

On Windows use `python` instead of `python3`. Open the local address printed by the server. Python and Rust are needed to build/run this source copy; packaged desktop releases bundle the runtime separately.

Connect a separately installed UHP engine through the viewer's Engine controls for computer play and analysis. Mzinga and Nokamute are supported. Building only `board_view` does not add a playing engine.

## Tests

Build all helper binaries before running the full viewer tests:

```
cargo build --release
cargo test
python3 -m unittest discover -s ui
```

For the combined viewer checks with isolated temporary data, install Node.js and run `python3 tools/check_viewer.py` after building the release helpers.

JavaScript checks are individual `ui/test_*.cjs` files, run with Node.js from this directory. Some tests are specific to macOS packaging or require an external engine. Read each test's setup before running it on another system.

## Desktop packaging

`ui/package_app.py` creates the macOS bundle. Its beta mode takes a compatible standalone Python distribution. `ui/package_windows.py` creates the Windows x64 folder using explicitly supplied Python runtime, compiled native launcher, compiled rules helper, toolchain files and license files. Use each script's `--help` for arguments.

This source archive does not contain compiled applications, runtimes, installed engines, credentials or live game data.

## Automated checks

GitHub Actions runs on pushes to `main`, pull requests, and manual requests. Both
macOS and Windows runners build all release helpers, run the Rust tests in debug
and release mode, and run the Python and JavaScript viewer regressions.

The macOS job also packages and starts a temporary app. Windows explicitly skips
that macOS-only packaging test and the external-engine test class whose mock
programs require POSIX scripts and executable permissions. The remaining Python
checks and every JavaScript suite run on both platforms. These checks do not
replace testing the downloadable release on real machines, native file dialogs,
sound, or separately installed engines. They do not create or publish releases.
