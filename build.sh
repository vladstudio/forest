#!/bin/bash
set -e
code --uninstall-extension vladstudio.vladstudio-forest || true
rm vladstudio-forest-*.vsix
bun run package
vsce package
code --install-extension vladstudio-forest-*.vsix
