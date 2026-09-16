# Validation and remaining checks

## Source build

The distributed source ZIP was extracted into a fresh directory, all Rust release binaries were built offline, and the resulting viewer package started and served its local assets. The supporting rules helper also passed a separate Cargo check. Python syntax and 17 focused external-engine tests passed.

## Mac Beta 3

The preceding Beta 3 validation completed 134 Python tests on both system and bundled Python, 25 JavaScript test suites, four isolated HTTP workflows, and 13 real Mzinga/Nokamute checks. It included packaged launch, review save/load, archive relocation, asset and signature checks, and inspection of light/dark browser screenshots.

The public package is rebuilt from the cleaned source. Personal development paths and image metadata were removed; image pixels are unchanged. The rebuilt package is checked again for bundled runtime startup, local assets, rules-helper operation, archive integrity and its ad-hoc signature.

## Windows Beta 3 preview

Test environment: Windows 11 ARM64 in Parallels, running the Intel/AMD x64 build through Windows compatibility support. Bundled Python, native launcher, rules helper, engine connection, human play, analytic notation, Unicode paths/metadata, PGN import/export and real Mzinga analysis were tested. Review stop/resume, full review completion, saved-review round trip and replacement warnings passed. Unauthenticated state-changing requests are rejected.

The public Windows ZIP is extracted and its internal hashes verified, then the isolated Mzinga integration checks are repeated. Mzinga and Nokamute each returned a legal move in separate Windows engine checks. Neither engine is bundled in the download.

## Limits

Separate Intel/AMD Windows hardware and a separate clean Mac remain to be tested. The Windows native engine file chooser, sound and complete interactive board-control coverage still need manual testing. No Windows 10 support claim is made. These are beta releases, without Microsoft certification or Apple notarization/Developer ID signing. Review labels and cross-engine normalized scores are estimates.

Tests use fixtures and temporary isolated data; no personal live games are included.
