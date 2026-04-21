#!/bin/bash
set -e
code --uninstall-extension vladstudio.vladstudio-forest 2>/dev/null || true
rm -f vladstudio-forest-*.vsix
bun run package
vsce package
code --install-extension vladstudio-forest-*.vsix
