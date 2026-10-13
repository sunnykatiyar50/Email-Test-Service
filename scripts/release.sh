#!/usr/bin/env bash
# Cuts a release: bumps the version, commits, tags and pushes.
#
#   scripts/release.sh patch|minor|major|<x.y.z> [--dry-run]
#
# Pushing the tag starts two GitHub Actions workflows:
#   docker.yml   tests, then publishes ghcr.io/<owner>/email-test-service:<version> (and :2.1, :2, :latest)
#   release.yml  creates the GitHub Release with notes and a docker-compose.yml pinned to the version
set -euo pipefail

bump="${1:-}"
dry_run=false
[ "${2:-}" = "--dry-run" ] && dry_run=true

if [ -z "$bump" ]; then
    echo "Usage: scripts/release.sh patch|minor|major|<x.y.z> [--dry-run]" >&2
    exit 1
fi

cd "$(dirname "$0")/.."

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
    echo "Releases are cut from main (you are on $branch)." >&2
    exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
    echo "The working tree has uncommitted changes. Commit or stash them first." >&2
    exit 1
fi

git fetch --quiet origin main --tags
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "main is not in sync with origin/main. Pull or push first." >&2
    exit 1
fi

echo "Running tests..."
npm test --silent

# Work out the new version without touching any files yet
current="$(node -p "require('./package.json').version")"
if [[ "$bump" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    new="$bump"
else
    new="$(node -e "
        const [a, b, c] = '$current'.split('.').map(Number);
        const kind = '$bump';
        if (!['patch', 'minor', 'major'].includes(kind)) process.exit(1);
        console.log((kind === 'major' ? [a + 1, 0, 0] : kind === 'minor' ? [a, b + 1, 0] : [a, b, c + 1]).join('.'));
    " 2>/dev/null)" || { echo "Unknown bump '$bump': use patch, minor, major or x.y.z." >&2; exit 1; }
fi
tag="v$new"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "Tag $tag already exists." >&2
    exit 1
fi

echo "Release: $current -> $new (tag $tag)"
if [ "$dry_run" = true ]; then
    echo "Dry run: nothing changed. Commits since the last tag:"
    git log --oneline "$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD"
    exit 0
fi

npm version "$new" --no-git-tag-version --silent
git add package.json package-lock.json
git commit -q -m "Release $tag"
git tag -a "$tag" -m "Release $tag"
git push origin main "$tag"

echo "Pushed $tag. Watch the workflows: gh run list --limit 3"
