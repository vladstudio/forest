#!/bin/bash
set -e
codium --uninstall-extension vladstudio.vladstudio-forest 2>/dev/null || true
rm -f vladstudio-forest-*.vsix
bun run package
vsce package
codium --install-extension vladstudio-forest-*.vsix
