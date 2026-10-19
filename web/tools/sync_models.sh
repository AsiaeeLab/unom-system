#!/usr/bin/env bash
# Recopy the model files and synthetic test bundles from model/ into the site, so the scorer
# on the website always runs the same files the Python reference was checked against.
# Usage: bash web/tools/sync_models.sh   (from anywhere)
set -euo pipefail

web_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$web_root/.." && pwd)"
src="$repo_root/model"
site="$web_root/web"

mkdir -p "$site/models" "$site/data/patients"

for f in longcovid.json longcovid.example.json chronicfatigue.json fibromyalgia.json endometriosis.json lyme.json lupus.json migraine.json depression.json anxiety.json; do
  cp "$src/$f" "$site/models/$f"
done

# Mirror the bundle directory exactly: drop site copies whose source was removed.
find "$site/data/patients" -maxdepth 1 -name '*.json' -type f | while read -r f; do
  [[ -f "$src/test_vectors/bundles/$(basename "$f")" ]] || rm -f "$f"
done
cp "$src"/test_vectors/bundles/*.json "$site/data/patients/"

echo "models:   $(ls "$site/models" | tr '\n' ' ')"
echo "patients: $(ls "$site/data/patients" | tr '\n' ' ')"
