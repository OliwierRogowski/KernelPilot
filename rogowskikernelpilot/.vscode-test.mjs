import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	...(process.env.KERNELPILOT_VSCODE_PATH
		? { useInstallation: { fromPath: process.env.KERNELPILOT_VSCODE_PATH } }
		: {}),
});
