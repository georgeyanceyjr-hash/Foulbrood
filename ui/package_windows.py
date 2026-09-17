"""Package an x64 Windows beta using explicitly supplied, local build inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import zipfile


def pe_x64(path):
    data = Path(path).read_bytes()
    offset = struct.unpack_from('<I', data, 0x3c)[0]
    if data[:2] != b'MZ' or data[offset:offset+4] != b'PE\0\0' or struct.unpack_from('<H', data, offset+4)[0] != 0x8664:
        raise ValueError('Expected an Intel/AMD 64-bit Windows executable: '+str(path))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('destination', type=Path)
    ap.add_argument('--python-zip', type=Path, required=True)
    ap.add_argument('--board-helper', type=Path, required=True)
    ap.add_argument('--launcher', type=Path, required=True)
    ap.add_argument('--toolchain', type=Path, required=True)
    ap.add_argument('--rust-docs', type=Path, required=True)
    args = ap.parse_args()
    root = Path(__file__).resolve().parents[1]
    app = args.destination/'FoulBrood-GUI-Beta-3-Windows-x64'
    if app.exists():
        ap.error('Use a new staging directory; destination already exists.')
    pe_x64(args.board_helper)
    pe_x64(args.launcher)
    resources = app/'Resources'
    (resources/'ui').mkdir(parents=True)
    (resources/'target/release').mkdir(parents=True)
    names = ['platform_support.py','external_engines.py','engines.js','hivegame.py',
             'game_review.py','review_file.py','live_analysis.py','review.js',
             'opening_book.py','analytic.py','server.py','import_game.py','export_game.py',
             'notation.py','index.html','style.css','app.js','pieces.js','foulbrood-hive.png']
    for name in names:
        shutil.copy2(root/'ui'/name, resources/'ui'/name)
    shutil.copytree(root/'ui/vendor', resources/'ui/vendor', ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    for name in ['launcher.py','launcher_windows.py']:
        shutil.copy2(root/'ui'/name, resources/name)
    for name in ['index.html','engines.js']:
        path = resources/'ui'/name
        text = path.read_text(encoding='utf-8').replace('Browse this Mac','Browse this PC')
        text = text.replace('extract a Mac engine','extract a Windows engine')
        text = text.replace('Mac downloads available. Connection verified with this viewer.', 'Windows downloads available. Choose the Windows x64 version.')
        text = text.replace('Mac users build from source.', 'Choose a Windows release or build from source.')
        text = text.replace('Intel Mac download; Apple silicon may need Rosetta or a build from source.', 'Choose a Windows build.')
        text = text.replace('<title>FoulBrood · Hive</title>', '<title>FoulBrood GUI · Beta 3 for Windows</title>')
        path.write_text(text, encoding='utf-8')
    runtime = resources/'python'
    runtime.mkdir()
    with zipfile.ZipFile(args.python_zip) as archive:
        for item in archive.infolist():
            target = (runtime/item.filename).resolve()
            if not target.is_relative_to(runtime.resolve()):
                raise ValueError('Unsafe Python archive entry')
        archive.extractall(runtime)
    pe_x64(runtime/'python.exe')
    pth = list(runtime.glob('python*._pth'))
    if len(pth) != 1:
        raise ValueError('Expected one embedded Python path configuration')
    # Embedded Python stays isolated from installed runtimes and user site packages.
    pth[0].write_text(pth[0].read_text().replace('#import site', '')+'\n..\n../ui\n', encoding='utf-8')
    shutil.copy2(args.board_helper, resources/'target/release/board_view.exe')
    unwind = args.toolchain/'x86_64-w64-mingw32/bin/libunwind.dll'
    pe_x64(unwind)
    shutil.copy2(unwind, resources/'target/release/libunwind.dll')
    shutil.copy2(args.launcher, app/'FoulBrood GUI.exe')
    licenses = resources/'Licenses'
    licenses.mkdir()
    shutil.copy2(root/'LICENSE', licenses/'FoulBrood-MIT.txt')
    shutil.copy2(args.toolchain/'LICENSE.TXT', licenses/'LLVM.txt')
    shutil.copytree(args.toolchain/'x86_64-w64-mingw32/share/mingw32', licenses/'MinGW')
    shutil.copy2(args.rust_docs/'COPYRIGHT-library.html', licenses/'Rust-library-copyright.html')
    shutil.copytree(args.rust_docs/'licenses', licenses/'licenses')
    (licenses/'Visual-Hive.txt').write_text('Analytic notation converter. Source included in Resources/ui/vendor/visual_hive.\n', encoding='utf-8')
    files = {str(p.relative_to(app)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(app.rglob('*')) if p.is_file()}
    build_id = hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()[:16]
    (resources/'beta.json').write_text(json.dumps(dict(version='0.1.0-beta.3-windows-preview', build_id=build_id, architecture='x86_64', engines_included=False),indent=2)+'\n',encoding='utf-8')
    (app/'START-HERE.txt').write_text('''FoulBrood GUI — Beta 3 Windows preview

1. Right-click the ZIP and choose Extract All.
2. Open the extracted folder and double-click FoulBrood GUI.exe.
3. The viewer opens in your default browser. Keep Resources beside the program.

For Intel/AMD 64-bit Windows 11. No Python installation is needed.
No playing engine is included. Use Engine > Find engines online to get a
Windows UHP engine, extract it, then Browse this PC > Add & connect.
Mzinga supports game review. Keep its companion files with its program.

This is an unsigned test build. Windows may show an unknown-publisher warning;
it has not been Microsoft-certified or tested on a separate Intel/AMD PC yet.

Settings and logs: %LOCALAPPDATA%\\FoulBrood GUI Beta
Games are held in memory. Use Save review or Export to keep your own games.
Pause games and stop analysis before closing the browser. The local viewer
helper remains running until Windows signs out or restarts.

Please report startup, engine connection, sound, import/export, review, and
board interaction problems with the steps that reproduce them.
''',encoding='utf-8')
    files = {str(p.relative_to(app)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(app.rglob('*')) if p.is_file()}
    (app/'SHA256SUMS.json').write_text(json.dumps(files,indent=2)+'\n',encoding='utf-8')
    print(app)


if __name__ == '__main__':
    main()
