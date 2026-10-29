#!/bin/zsh
# Publishes this folder as a public GitHub Pages site: https://nerlybit2.github.io/lira-rune-forest/
# Safe to run again: it reuses the repo if it already exists and force-pushes the current files.
set -e
cd "$(dirname "$0")"
rm -rf .git
git init -q -b main
git config http.postBuffer 524288000   # the 5MB of art fails with HTTP 400 on the default buffer
git add -A
git -c user.email=nerlybiton@gmail.com -c user.name="Nerly Biton" commit -qm "Lira: Rune Forest web build"
gh repo view nerlybit2/lira-rune-forest >/dev/null 2>&1 || gh repo create lira-rune-forest --public
git remote add origin https://github.com/nerlybit2/lira-rune-forest.git
git push -q -f -u origin main
gh api repos/nerlybit2/lira-rune-forest/pages >/dev/null 2>&1 || gh api -X POST repos/nerlybit2/lira-rune-forest/pages -f "source[branch]=main" -f "source[path]=/" >/dev/null
echo "Live in about a minute: https://nerlybit2.github.io/lira-rune-forest/"
