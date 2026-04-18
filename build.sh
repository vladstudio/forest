#!/bin/bash
set -e
codium --uninstall-extension vladstudio.vladstudio-forest || true
rm vladstudio-forest-*.vsix
bun run package
vsce package
codium --install-extension vladstudio-forest-*.vsix
