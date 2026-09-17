# FoulBrood GUI

A local Hive board-game viewer for playing, exploring positions and reviewing games. Connect your own UHP engine; no playing engine is bundled or required for human play.

## Downloads

- [Mac — Apple Silicon, Beta 3](https://github.com/georgeyanceyjr-hash/Foulbrood/releases/tag/beta-3-macos)
- [Windows — Intel/AMD x64, Beta 3 preview](https://github.com/georgeyanceyjr-hash/Foulbrood/releases/tag/beta-3-windows)

Each release has its own download and setup instructions. Both include their Python runtime. The Windows x64 build has been tested under Windows 11 ARM compatibility in Parallels; testing on a separate Intel/AMD PC is still needed. The Mac build targets Apple Silicon. These beta packages are unsigned/not notarized for public distribution.

## Features

- Human play and UHP engine play, including engine-versus-engine games and game clocks.
- Position setup and analysis; full-game review with played/preferred comparisons and move differences.
- Engine information in player bars, gold White suggestions and blue Black suggestions.
- Board flip, rotation, zoom, auto fitting and optional notation that follows board orientation.
- Traditional and Analytic notation, move history, PGN/JSON import/export and hivegame.com imports.
- Save and load reviewed games as PGN, preserving analysis; resume interrupted reviews.
- Light and dark themes, sound and spoken countdown controls.

## Start here

[User guide](docs/USER-GUIDE.md) · [Build from source](docs/BUILD.md) · [Beta 3 changes](docs/CHANGELOG.md) · [Validation and limits](docs/VALIDATION.md)

For analysis, download a compatible engine separately: [Mzinga](https://github.com/jonthysell/Mzinga/releases) or [Nokamute](https://github.com/edre/nokamute/releases). Keep each engine with its companion files and connect it in the Engine panel. Arbitrary rearranged setups cannot be analyzed by engines whose interfaces require game history.

The Rust rules helper is included to validate moves and maintain board state. It is separate from the playing engine you select. Search modules remain in the source because the shared Rust library references them; this repository is the viewer source snapshot.

## Source layout

`ui/` contains the interface, Python service, engine adapters, launchers and packagers. `src/` contains the supporting Rust library and helper binaries. `tests/`, `ui/test_*` and their fixtures cover rules and viewer behavior.

## Feedback

Report bugs or suggest improvements on the [Issues page](https://github.com/georgeyanceyjr-hash/Foulbrood/issues). For a bug report, include whether you use Mac or Windows, what you were doing, and what went wrong. A screenshot can help.

## License

FoulBrood's original code is available under the [MIT license](LICENSE). Notices for third-party components are included with each download.
