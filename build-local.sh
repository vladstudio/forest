#!/bin/bash
VERSION=$(node -p "require('./package.json').version")
bun run package && bunx @vscode/vsce package && code --install-extension "vladstudio-forest-${VERSION}.vsix" --force && echo "Installed v${VERSION}. Reload VS Code windows to activate."
