#!/bin/bash
set -e
bun run package
vsce package
code --install-extension vladstudio-forest-*.vsix
