#!/bin/bash
bun run package && bunx @vscode/vsce package && code --install-extension forest-0.1.0.vsix
