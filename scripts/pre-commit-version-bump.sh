#!/bin/sh
#
# Pre-commit hook: auto-increment patch version in package.json
# when staged changes touch server/ or src/ (i.e. actual code, not docs).
#
# Install:  git config core.hooksPath is not set, so either:
#   ln -sf ../../scripts/pre-commit-version-bump.sh .git/hooks/pre-commit
#   — or —
#   git config core.hooksPath scripts/githooks

# Only act when code files are staged
STAGED=$(git diff --cached --name-only)
echo "$STAGED" | grep -qE '^(server/|src/)' || exit 0

# Don't bump if package.json is already staged (manual bump or avoid double-bump)
echo "$STAGED" | grep -q '^package.json$' && exit 0

# Read current version
VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/')
if [ -z "$VERSION" ]; then
  echo "pre-commit: could not parse version from package.json" >&2
  exit 0
fi

MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f2)
PATCH=$(echo "$VERSION" | cut -d. -f3)
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$NEW_PATCH"

# Update package.json in-place
sed -i.bak "s/\"version\": \"$VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json
rm -f package.json.bak

# Stage the bumped file so it's included in this commit
git add package.json

echo "pre-commit: version bumped $VERSION → $NEW_VERSION"
