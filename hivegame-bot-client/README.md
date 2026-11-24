# hivegame.com bot client

The program the viewer's **Live** tab runs to play on hivegame.com as a bot account.

It is a modified copy of `hive-hydra` from [hiveboardgame/hive](https://github.com/hiveboardgame/hive), which is
licensed under the GNU Affero General Public License v3 (see `LICENSE.md` in this folder). This folder stays under
that licence; the rest of this repository is MIT.

Changes from upstream:

- thinking time taken from the game clock
- status lines on standard output for the viewer (games, clocks, ratings, the engine's depth, score and move,
  the lobby's challenges and who is online)
- commands on standard input: accept rules (time control, humans only), accept one challenge, send or open a
  challenge (colour, rating range)
- games the server no longer lists are reported as gone

The viewer builds it with `cargo build --release` the first time the bot is started.
