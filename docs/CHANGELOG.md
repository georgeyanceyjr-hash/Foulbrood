# New look (24 November 2026)

- A flatter, harder-edged look in black, bone and hazard yellow, in both dark and light mode: block-capital wordmark, hazard stripe under the header, underlined tab row, square corners.
- The pieces, the board controls and the gold/blue move highlights are unchanged; in dark mode the tiles are a shade darker.
- On the board: targeting brackets, a status tag ("Outbreak in progress · move N"), and a game-over stamp naming the winner and loser (QUEEN DOWN, QUEENS DOWN for a double kill, STANDOFF for a draw by repetition, SURRENDER, OUT OF TIME).
- No option was removed.

# Sound effects, built-in engine, history follows the board (24 November 2026)

- New generated sound effects: a swarm and a splat when you win, a dying bee when you lose, a rattle when a queen has five of six sides covered, a swarm swell at game start, a heartbeat under the last ten seconds, and a stinger when the bot finds a game. Try-out buttons are in the sound settings.
- The move list always flips and rotates with the board, on Play, Live and Analysis.
- The FoulBrood engine is built in: it cannot be disconnected or removed, and is put back if missing.

# History tab (24 November 2026)

- Added a **History** tab (Play, Live, Analysis, History, Engine): every game played in the viewer, played by the bot on hivegame.com, or imported is saved automatically when it ends or is brought in.
- Each game shows the players, ratings and rating changes where known, result, number of moves, time control, where it came from, and date and time.
- Games can be searched, starred (starred games stay at the top), opened in Analysis (asking first if Analysis already holds a game) or deleted.
- Finished and partial game reviews are saved with their game and reopen with it.

# Live tab (24 November 2026)

- Added a **Live** tab between Play and Analysis for playing on hivegame.com with a bot account: log in (saved in the macOS Keychain), pick the engine, and watch the game on the board with clocks, sounds and the engine's thinking in the player bars.
- Player bars show each player's hivegame.com rating, the rating change when the game ends, Bot or Human, and their record at that speed.
- Three challenge boxes: accept a waiting challenge (or accept automatically), open a challenge to the lobby with a rating range, or send one to a player who is online. Colour, time control and rated/casual can be chosen.
- "Open current position/game in Analysis" takes the Live board to the Analysis tab.
- Every sidebar box folds, with one title style.
- The FoulBrood engine is listed as "FoulBrood" and "FoulBrood Book".
- Live keeps its own board: the game in Analysis is set aside when Live opens and put back when you return to Analysis.
- "Open current game in Analysis" asks before replacing a game already in Analysis; "Clear game" clears the Live board and history, also after asking.
- The bot's status shows on three lines, and a sent challenge is only shown while it is waiting.
- Includes the viewer changes made since Beta 3.

# Beta 3

- Moved engine insights into the player bars above and below the board, with consistent position score bars.
- Added game-review played/preferred comparisons, sortable move differences and shared history navigation.
- Added reviewed PGN save/load, resumable review, replacement warnings and recorded in-game analysis.
- Improved notation behavior across flips, rotations, review and analysis.
- Added longer analysis times and Match timing for Play.
- Improved board fitting, result messages, spacing, clocks, sound and light-theme colors.
- Added a portable Windows x64 preview with an embedded runtime and native launcher.

Known limitations and validation scope are documented separately. Engine scores and move classifications are estimates, not objective guarantees.
