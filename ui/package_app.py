#!/usr/bin/env python3
"""Assemble a portable local app from the checked build, without network access."""
import argparse
import hashlib
import json
import base64
from pathlib import Path
import plistlib
import shutil
import subprocess

root=Path(__file__).resolve().parents[1]
ap=argparse.ArgumentParser();ap.add_argument('destination');ap.add_argument('--beta',action='store_true');ap.add_argument('--python-distribution',type=Path);args=ap.parse_args()
if args.beta and not args.python_distribution:ap.error('--beta requires --python-distribution')
app=Path(args.destination)/('FoulBrood GUI Beta.app' if args.beta else 'FoulBrood.app');contents=app/'Contents'
if app.exists():raise SystemExit('Destination app already exists; use a new staging directory.')
(contents/'MacOS').mkdir(parents=True,exist_ok=True)
resources=contents/'Resources'
(resources/'ui').mkdir(parents=True,exist_ok=True)
(resources/'target/release').mkdir(parents=True,exist_ok=True)
for name in ['platform_support.py','external_engines.py','engines.js','hivegame.py','game_review.py','review_file.py','live_analysis.py','review.js','opening_book.py','draft_opening_book.json','analytic.py','server.py','import_game.py','export_game.py','notation.py','index.html','style.css','app.js','pieces.js','foulbrood-hive.png']:
    shutil.copy2(root/'ui'/name,resources/'ui'/name)
# Inline header art so existing running app versions can refresh without losing games.
html=resources/'ui/index.html'
html.write_text(html.read_text().replace('/foulbrood-hive.png','data:image/png;base64,'+base64.b64encode((root/'ui/foulbrood-hive.png').read_bytes()).decode()))
shutil.copytree(root/'ui/vendor',resources/'ui/vendor',dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
for name in (['board_view'] if args.beta else ['board_view','bench_search','foulbrood']):
    shutil.copy2(root/'target/release'/name,resources/'target/release'/name)
launcher=contents/'MacOS/FoulBrood'
shutil.copy2(root/'ui/launcher.py',resources/'launcher.py')
subprocess.run(['/usr/bin/clang',str(root/'ui/launcher.c'),'-Os','-mmacosx-version-min=11.0','-o',str(launcher)],check=True)
launcher.chmod(0o755)
with (contents/'Info.plist').open('wb') as f:
    plistlib.dump(dict(CFBundleExecutable='FoulBrood',CFBundleIdentifier='local.foulbrood.gui.beta' if args.beta else 'local.foulbrood.board',
                      CFBundleName='FoulBrood GUI Beta' if args.beta else 'FoulBrood',CFBundleDisplayName='FoulBrood GUI Beta' if args.beta else 'FoulBrood',CFBundlePackageType='APPL',
                      CFBundleVersion='3' if args.beta else '13',CFBundleShortVersionString='0.1.0' if args.beta else '0.13',LSMinimumSystemVersion='11.0',LSUIElement=True),f)
if args.beta:
    distribution=args.python_distribution
    metadata=json.loads((distribution/'PYTHON.json').read_text())
    if metadata['target_triple']!='aarch64-apple-darwin':raise SystemExit('Beta 3 requires Apple Silicon Python.')
    runtime=resources/'python';(runtime/'bin').mkdir(parents=True)
    version=metadata['python_major_minor_version']
    shutil.copy2(distribution/'install/bin'/('python'+version),runtime/'bin/python3')
    shutil.copytree(distribution/'install/lib',runtime/'lib',ignore=shutil.ignore_patterns('*.a','__pycache__','site-packages','pkgconfig','config-*','test','tests'))
    licenses=resources/'Licenses';licenses.mkdir()
    shutil.copy2(root/'LICENSE',licenses/'FoulBrood-MIT.txt')
    shutil.copytree(distribution/'licenses',licenses/'Python')
    shutil.copy2(distribution/'PYTHON.json',licenses/'Python-distribution.json')
    (licenses/'Visual-Hive.txt').write_text('Visual Hive notation converter. Included with permission. Original source retained in Resources/ui/vendor/visual_hive. No separate upstream license was supplied.\n')
    (resources/'ui/index.html').write_text((resources/'ui/index.html').read_text().replace('<title>FoulBrood · Hive</title>','<title>FoulBrood GUI · Beta 3</title>'))
    files={str(p.relative_to(resources)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(resources.rglob('*')) if p.is_file()}
    build_id=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()[:16]
    (resources/'beta.json').write_text(json.dumps(dict(version='0.1.0-beta.3',build_id=build_id,architecture='arm64',engines_included=False,python_version=metadata['python_version']),indent=2)+'\n')
    # Ad-hoc integrity signatures are local and do not claim Developer ID/notarization.
    for path in sorted(app.rglob('*')):
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as f:magic=f.read(4)
            if magic in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe',b'\xca\xfe\xba\xbe'):
                subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(path)],check=True,capture_output=True)
    subprocess.run(['/usr/bin/codesign','--force','--deep','--sign','-',str(app)],check=True,capture_output=True)
    subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True,capture_output=True)
if args.beta:
    for guide in (root/'ui/beta').iterdir():
        if guide.is_file():shutil.copy2(guide,Path(args.destination)/guide.name)
print(app)
