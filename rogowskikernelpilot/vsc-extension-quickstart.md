# Extension development quickstart

This directory contains the VS Code extension. For the user-facing setup and first run, see the [project README](../README.md) and [getting started guide](../docs/getting-started.md).

## Build and run

```sh
npm ci
npm run compile
npm run check-types
npm run lint
```

Open this directory in VS Code and press **F5** to launch the Extension Development Host. The extension loads the generated `dist/extension.js` bundle.

Run the full extension test suite with `npm test`; it launches a VS Code test host and may include GPU-dependent integration tests. See [Contributing](../CONTRIBUTING.md) for test environment details and overrides.

The extension registers its real commands in `package.json` and `src/extension.ts`. In particular, there is no template **Hello World** command in this project.
