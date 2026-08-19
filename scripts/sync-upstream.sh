#!/usr/bin/env bash
# sync-upstream.sh — manual upstream sync for this fork (conflict-resolution path
# for the Sync Upstream GitHub Action, which opens an [upstream-sync] issue when
# its automatic merge --squash hits conflicts).
#
# The Action (`.github/workflows/sync-upstream.yml`) squashes all fork work into a
# single commit on top of upstream-image and force-pushes main. This script mirrors
# that exact flow locally. Extensions are NOT tracked in this repo — they live in
# the user-level checkout (~/.pi/agent/extensions, a clone of seek-hope/pi-extensions)
# — so no submodule handling is needed here; upstream's tracked .pi/extensions
# files simply come and go with the merge.
#
# Roles (do not edit outside the hub):
#   ~/Projects/Code/for_fun/pi-extensions  — editing hub for extensions
#   ~/.pi/agent/extensions                 — deployment checkout; pi auto-pulls it
#                                            on startup (auto-update.ts)
#
# Usage:
#   scripts/sync-upstream.sh            # sync; stops for manual conflict resolution
#   scripts/sync-upstream.sh --continue # after resolving: squash-commit, verify, push
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

die() { echo "sync-upstream: $*" >&2; exit 1; }

if [ "${1:-}" = "--continue" ]; then
	# Resume after conflicts were resolved and staged.
	git diff --name-only --diff-filter=U | grep -q . && die "unresolved conflicts remain"
	MSG_FILE=".git/SYNC_SQUASH_MSG"
	[ -f "$MSG_FILE" ] || die "no pending sync (missing $MSG_FILE) — run without --continue"
	TIP=$(cat .git/SYNC_SQUASH_TIP)
	git reset --soft "origin/upstream-image"
	git commit -F "$MSG_FILE"
	rm -f "$MSG_FILE" .git/SYNC_SQUASH_TIP
	npm run check
	git push origin "upstream-image" --force-with-lease
	git push origin "main:main" --force-with-lease
	echo "sync-upstream: main squashed onto upstream $TIP and pushed"
	exit 0
fi

git fetch upstream
git fetch origin upstream-image main

[ -n "$(git status --porcelain --untracked-files=no)" ] && die "working tree has staged/modified files; commit or stash them first"

# Point upstream-image at the latest upstream tip.
git push origin "refs/remotes/upstream/main:refs/heads/upstream-image" --force-with-lease
git checkout -B upstream-image origin/upstream-image --
TIP=$(git rev-parse --short upstream/main)

if [ "$(git rev-parse origin/main)" = "$(git rev-parse upstream-image)" ]; then
	echo "sync-upstream: main is already up to date with upstream ($TIP)"
	git checkout -B main origin/main --
	exit 0
fi

# The Action force-pushes squash commits, so local main is often stale; start
# from the remote state.
git checkout -B main origin/main --
echo "sync-upstream: squashing fork work onto upstream $TIP"

if ! git merge --squash origin/upstream-image; then
	cat >&2 <<'EOF'

sync-upstream: merge conflicts. Resolve them, then:
  git add <resolved files>
  scripts/sync-upstream.sh --continue
To abandon:
  git merge --abort
EOF
	echo "squash: fork work onto upstream $TIP" > .git/SYNC_SQUASH_MSG
	echo "$TIP" > .git/SYNC_SQUASH_TIP
	exit 1
fi

git reset --soft origin/upstream-image
git commit -m "squash: fork work onto upstream $TIP"
npm run check
git push origin upstream-image --force-with-lease
git push origin main:main --force-with-lease
echo "sync-upstream: main squashed onto upstream $TIP and pushed"
