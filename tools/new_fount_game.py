#!/usr/bin/env python3
"""Scaffold a standalone Fount game project that Claude Code can work on.

    python3 tools/new_fount_game.py ../my-game
    python3 tools/new_fount_game.py ../my-game --name "Cliffside"
    python3 tools/new_fount_game.py ../existing-repo --vendor-only
    python3 tools/new_fount_game.py ../my-game --update
    python3 tools/new_fount_game.py ../my-game --update --editor
    python3 tools/new_fount_game.py ../my-game --dry-run

The result is self-sufficient: the engine is vendored in (it has no
dependencies, so a copy beats a submodule), and the fount-gamedev skill is
installed at .claude/skills/ inside the project. That second part is what
connects the game to Claude Code — a session opened on the game's own repo
discovers the skill as a project skill with no extra setup, so Claude already
knows the map format and entity library without SuperClaude being present.

Stdlib only, no network access. Nothing is pushed anywhere; the script prints
the git remote steps for you to run when you're ready.
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENGINE_SRC = REPO_ROOT / "apps" / "fount"
SKILL_SRC = REPO_ROOT / "skills" / "fount-gamedev"
MANIFEST_NAME = ".fount-vendor.json"

# Directories this script owns and may refresh on --update. Everything else in
# the project belongs to the person building the game and is never touched.
VENDORED = ["engine", "server", ".claude/skills/fount-gamedev"]
SKILL_EXCLUDE = {"evals"}

GREEN, YELLOW, RED, DIM, BOLD, RESET = (
    ("\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[1m", "\033[0m")
    if sys.stdout.isatty() else ("", "", "", "", "", "")
)


def engine_version():
    """Identify the vendored engine by the commit it came from, when available."""
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "unknown"


STARTER_MAP = {
    "name": "start",
    "sky": {
        "color": [0.36, 0.45, 0.58],
        "sunDir": [-0.4, -0.82, -0.4],
        "sunColor": [1.05, 0.98, 0.88],
        "ambient": [0.3, 0.32, 0.38],
        "fogDensity": 0.01,
    },
    "brushes": [
        {"type": "box", "min": [-12, -1, -12], "max": [12, 0, 12], "material": "floor_tile"},
        {"type": "box", "min": [-13, 0, -13], "max": [13, 5, -12], "material": "concrete"},
        {"type": "box", "min": [-13, 0, 12], "max": [13, 5, 13], "material": "concrete"},
        {"type": "box", "min": [-13, 0, -13], "max": [-12, 5, 13], "material": "concrete"},
        {"type": "box", "min": [12, 0, -13], "max": [13, 5, 13], "material": "concrete"},
        {"type": "box", "min": [4, 0, -10], "max": [10, 2, -4], "material": "concrete"},
        {"type": "ramp", "min": [4, 0, -4], "max": [10, 2, 0],
         "material": "metal", "axis": "z", "dir": -1, "low": 0},
    ],
    "entities": [
        {"classname": "info_player_start", "origin": [0, 0.2, 8], "angles": [0, 90, 0]},
        {"classname": "light", "origin": [0, 4, 0], "color": [1.0, 0.9, 0.72], "radius": 16},
        {"classname": "light", "origin": [7, 3, -7], "color": [0.7, 0.85, 1.0], "radius": 10},
        {"classname": "npc_grunt", "name": "guard_1", "origin": [7, 2.1, -7],
         "angles": [0, 225, 0], "health": 40},
        {"classname": "prop_physics", "origin": [-3, 1.5, -2], "size": [0.35, 0.35, 0.35]},
        {"classname": "item_health", "origin": [-8, 0.1, 8], "amount": 25},
    ],
}


def project_readme(title, slug):
    return f"""# {title}

A game built on the [Fount engine](https://github.com/thatrgbgamer/SuperClaude-FountEngine) —
a dependency-free WebGL2 FPS engine whose levels, entities, materials and
sounds are all plain text. This project runs entirely offline with no API
key and no per-play cost.

## Run it

```sh
./run.sh
```

Then open <http://localhost:8099/>. The in-browser editor is at
<http://localhost:8099/editor/index.html>.

ES modules need a real HTTP origin, so opening `index.html` from the
filesystem won't work. There's no build step — edit a file, refresh.

## Play it with other people

```sh
./serve.sh --name "{title}"
```

That serves the game *and* hosts the multiplayer session on the same port, so
players just open the page and type `connect` in the console (`` ` `` opens it).
Node 18+, no `npm install`. The terminal you started it in is the admin console —
type `help` there for `kick`, `ban`, `map` and the rest.

To put it on the internet, deploy this repo as-is: the engine and the server are
both vendored, so `git clone && ./serve.sh` on any box with Node is the whole
deployment. See the engine README's multiplayer section for tunnels, reverse
proxies and a systemd unit.

## Building this game with Claude Code

This repo ships the `fount-gamedev` skill at `.claude/skills/fount-gamedev/`,
so a Claude Code session opened here already knows the map format, the entity
library and the input/output logic system. Nothing to install. Just ask:

> "Add a courtyard with a sniper tower and three guards."

The skill's reference docs are worth reading directly too:

- `.claude/skills/fount-gamedev/references/map-format.md` — brushes, materials, lighting, scale
- `.claude/skills/fount-gamedev/references/entities.md` — every entity, keyvalue, input and output
- `.claude/skills/fount-gamedev/references/custom-behaviors.md` — writing new entity behaviours

## Layout

```text
{slug}/
├── run.sh                  Serve the game locally
├── serve.sh                Run a multiplayer server
├── package.json            Marks the engine's .js as ES modules; no deps
├── index.html              Game shell and HUD; the map list lives here
├── editor/index.html       In-browser level editor
├── engine/                 Vendored Fount engine — don't edit to build a game
├── server/                 Vendored multiplayer server — likewise
└── game/
    ├── maps/               Your levels (JSON)
    └── scripts/            Your custom entity behaviours (JS)
```

## Adding a level

Create `game/maps/<name>.json`, then register it in the `MAPS` array in both
`index.html` and `editor/index.html` so it appears in the map picker.

## Updating the engine

`engine/`, `server/` and `.claude/skills/fount-gamedev/` are vendored copies. To
pull in a newer version, clone the engine repo and re-run the scaffolder against this
directory:

```sh
git clone https://github.com/thatrgbgamer/SuperClaude-FountEngine.git
python3 SuperClaude-FountEngine/tools/new_fount_game.py . --update
```

That refreshes only the vendored directories; your `game/` content, `index.html`
and this README are never overwritten.

## License

MIT for the engine (see `engine/LICENSE-FOUNT`). Your game content is yours.
"""


# Node needs to know the engine's .js files are ES modules, because the
# multiplayer server imports the engine's collision code to validate players.
# In a project whose package.json says CommonJS, Node refuses to load them at
# all. No dependencies, nothing to install — just the module type.
PACKAGE_JSON = """{{
  "name": "{slug}",
  "private": true,
  "type": "module"
}}
"""


GITIGNORE = """.DS_Store
Thumbs.db
*.swp
.vscode/
.idea/
__pycache__/
"""

MIT_TEMPLATE = """MIT License

Copyright (c) {year} {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""


def rewrite_map_list(html_text, entries):
    """Point the page's MAPS array at this project's maps instead of the demos."""
    start = html_text.find("const MAPS = [")
    if start == -1:
        return html_text
    end = html_text.find("];", start)
    if end == -1:
        return html_text
    lines = ",\n".join(
        f"  {{ file: '{f}', label: '{label}' }}" for f, label in entries
    )
    return html_text[:start] + "const MAPS = [\n" + lines + ",\n" + html_text[end:]


def copy_tree(src, dest, exclude=None):
    exclude = exclude or set()
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        src, dest,
        ignore=lambda directory, names: {n for n in names if n in exclude},
    )


def vendor(target, dry_run):
    """Copy the engine and the skill in. These are the only managed paths."""
    actions = []

    engine_dest = target / "engine"
    actions.append(("engine/", "refresh" if engine_dest.exists() else "add"))
    if not dry_run:
        copy_tree(ENGINE_SRC / "engine", engine_dest)
        # Ship the engine's licence alongside the copy so attribution travels.
        license_src = REPO_ROOT / "LICENSE"
        if license_src.exists():
            shutil.copy2(license_src, engine_dest / "LICENSE-FOUNT")

    # The multiplayer server is engine code too, so it is managed the same way:
    # a game that vendors both can be deployed straight from its own repo.
    server_dest = target / "server"
    actions.append(("server/", "refresh" if server_dest.exists() else "add"))
    if not dry_run:
        copy_tree(ENGINE_SRC / "server", server_dest)

    skill_dest = target / ".claude" / "skills" / "fount-gamedev"
    actions.append((".claude/skills/fount-gamedev/", "refresh" if skill_dest.exists() else "add"))
    if not dry_run:
        copy_tree(SKILL_SRC, skill_dest, exclude=SKILL_EXCLUDE)

    return actions


def refresh_editor(target, dry_run):
    """Replace editor/index.html with the engine's current editor.

    The editor is not one of the managed paths, because it is yours once
    scaffolded (its map list is edited by hand). --editor is the opt-in way to
    pick up editor features, such as the top-down view: it takes the engine's
    editor and rebuilds its map list from whatever is in your game/maps/, so
    nothing you registered is lost. The game's own index.html is never touched.
    """
    maps_dir = target / "game" / "maps"
    maps = [(f"game/maps/{p.name}", p.stem) for p in sorted(maps_dir.glob("*.json"))] if maps_dir.is_dir() else []
    dest = target / "editor" / "index.html"
    action = "refresh" if dest.exists() else "add"
    if not dry_run:
        dest.parent.mkdir(parents=True, exist_ok=True)
        text = (ENGINE_SRC / "editor" / "index.html").read_text(encoding="utf-8")
        dest.write_text(rewrite_map_list(text, maps) if maps else text, encoding="utf-8")
    return action, len(maps)


def scaffold(target, title, slug, holder, dry_run):
    """Create the project-owned files, but never clobber ones already there."""
    created, skipped = [], []

    def write(rel, content):
        path = target / rel
        if path.exists():
            skipped.append(rel)
            return
        created.append(rel)
        if dry_run:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    write("game/maps/start.json", json.dumps(STARTER_MAP, indent=2) + "\n")
    write("game/scripts/README.md",
          "# Custom entity behaviours\n\n"
          "Drop `defineEntity` modules here and import them from `index.html`.\n"
          "See `.claude/skills/fount-gamedev/references/custom-behaviors.md`.\n")
    write("README.md", project_readme(title, slug))
    write(".gitignore", GITIGNORE)
    write("package.json", PACKAGE_JSON.format(slug=slug))
    write("LICENSE", MIT_TEMPLATE.format(year=time.strftime("%Y"), holder=holder))

    maps = [("game/maps/start.json", "start — your first level")]
    for rel, src in (("index.html", ENGINE_SRC / "index.html"),
                     ("editor/index.html", ENGINE_SRC / "editor" / "index.html")):
        if (target / rel).exists():
            skipped.append(rel)
            continue
        created.append(rel)
        if not dry_run:
            (target / rel).parent.mkdir(parents=True, exist_ok=True)
            (target / rel).write_text(rewrite_map_list(src.read_text(encoding="utf-8"), maps),
                                      encoding="utf-8")

    for script in ("run.sh", "serve.sh"):
        if (target / script).exists():
            skipped.append(script)
            continue
        created.append(script)
        if not dry_run:
            shutil.copy2(ENGINE_SRC / script, target / script)
            (target / script).chmod(0o755)

    return created, skipped


def init_git(target, dry_run):
    if (target / ".git").exists():
        return "already a git repo"
    if dry_run:
        return "would run git init"
    try:
        subprocess.run(["git", "init", "-q"], cwd=target, check=True, timeout=20)
        subprocess.run(["git", "add", "-A"], cwd=target, check=True, timeout=30)
        subprocess.run(
            ["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m",
             "Scaffold Fount game project"],
            cwd=target, check=True, timeout=30,
        )
        return "git repo initialised with a first commit"
    except (OSError, subprocess.SubprocessError) as exc:
        return f"git init skipped ({exc})"


def main():
    parser = argparse.ArgumentParser(
        description="Scaffold a standalone Fount game project wired for Claude Code.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("\n\n", 1)[1],
    )
    parser.add_argument("target", help="directory for the game project")
    parser.add_argument("--name", help="display name for the game (default: the directory name)")
    parser.add_argument("--holder", default="the game's authors",
                        help="copyright holder written into LICENSE")
    parser.add_argument("--vendor-only", action="store_true",
                        help="only add engine/ and the skill, for an existing project")
    parser.add_argument("--update", action="store_true",
                        help="refresh the vendored engine and skill, leaving game content alone")
    parser.add_argument("--editor", action="store_true",
                        help="also replace editor/index.html with the engine's current editor, "
                             "keeping a map list built from your game/maps/ (never touches index.html)")
    parser.add_argument("--no-git", action="store_true", help="skip git init")
    parser.add_argument("--dry-run", action="store_true", help="show what would happen")
    args = parser.parse_args()

    if not ENGINE_SRC.is_dir() or not SKILL_SRC.is_dir():
        print(f"{RED}Cannot find the engine or skill to vendor from {REPO_ROOT}.{RESET}", file=sys.stderr)
        return 1

    target = Path(args.target).expanduser().resolve()
    # A game meant to become its own repo should not be nested inside this one.
    if target == REPO_ROOT or REPO_ROOT in target.parents:
        print(f"{RED}Refusing to scaffold inside the SuperClaude repo itself.{RESET}", file=sys.stderr)
        print("Pick a path outside it, e.g. ../my-game", file=sys.stderr)
        return 1

    slug = target.name
    title = args.name or slug.replace("-", " ").replace("_", " ").title()
    vendor_only = args.vendor_only or args.update

    print(f"\n{BOLD}{'Updating' if args.update else 'Scaffolding'} {title}{RESET}  {DIM}{target}{RESET}\n")
    if not args.dry_run:
        target.mkdir(parents=True, exist_ok=True)

    for rel, action in vendor(target, args.dry_run):
        verb = "would " + action if args.dry_run else action + "ed" if action == "refresh" else "added"
        print(f"  {GREEN}{verb}{RESET} {rel}")

    if args.editor:
        action, count = refresh_editor(target, args.dry_run)
        verb = f"would {action}" if args.dry_run else ("refreshed" if action == "refresh" else "added")
        print(f"  {GREEN}{verb}{RESET} editor/index.html {DIM}({count} maps listed from game/maps/){RESET}")

    if not vendor_only:
        created, skipped = scaffold(target, title, slug, args.holder, args.dry_run)
        for rel in created:
            print(f"  {GREEN}{'would add' if args.dry_run else 'added'}{RESET} {rel}")
        for rel in skipped:
            print(f"  {YELLOW}kept{RESET}      {rel} {DIM}(already exists — yours, not touched){RESET}")

    if not args.dry_run:
        (target / MANIFEST_NAME).write_text(json.dumps({
            "engine": "fount",
            "engineVersion": engine_version(),
            "vendoredAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "vendoredPaths": VENDORED,
            "source": "https://github.com/thatrgbgamer/SuperClaude-FountEngine",
        }, indent=2) + "\n", encoding="utf-8")

    if args.dry_run:
        print(f"\n{DIM}Dry run — nothing was written.{RESET}\n")
        return 0

    git_note = "skipped (--no-git)" if args.no_git or vendor_only else init_git(target, args.dry_run)

    print(f"\n{BOLD}Done.{RESET} {DIM}{git_note}{RESET}")
    if args.update:
        print("Engine, server and skill refreshed. Your game content was left untouched.\n")
        return 0

    if args.vendor_only:
        print(f"""
Fount is now vendored into this project. Nothing else was added or changed.

To wire it up, serve the directory over HTTP and point a page at
`engine/game.js` — copy `index.html` from the Fount repo if you want the stock
shell, and add `--editor` to this command for the editor.

A Claude Code session opened here now finds the fount-gamedev skill at
.claude/skills/, so it already knows the map format and entity library.
""")
        return 0

    print(f"""
Next:
  cd {target}
  ./run.sh                      {DIM}# play it at http://localhost:8099/{RESET}
  ./serve.sh                    {DIM}# or host a multiplayer server on the same port{RESET}

To put it on GitHub (nothing was pushed for you):
  gh repo create {slug} --source=. --private --push
  {DIM}# or create the repo on github.com, then:{RESET}
  {DIM}# git remote add origin <url> && git push -u origin main{RESET}

Then open Claude Code in this directory and ask for a level — the
fount-gamedev skill is already installed at .claude/skills/, so it knows
the map format without any further setup.
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
