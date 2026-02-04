const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	// Build extension (Node.js)
	const extensionCtx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: !production,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', 'duckdb'],
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
		// graphologyのnpm版events依存をNode.js組み込みモジュールにエイリアス
		alias: {
			'events': 'node:events',
		},
	});

	// Build webview script (Browser) - Cytoscape version
	const webviewCtx = await esbuild.context({
		entryPoints: [
			'src/webview/graphView.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: !production,
		platform: 'browser',
		outfile: 'dist/webview/graphView.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	// Build webview script (Browser) - Cosmos.gl version
	const cosmosViewCtx = await esbuild.context({
		entryPoints: [
			'src/webview/cosmosView.ts'
		],
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: !production,
		platform: 'browser',
		outfile: 'dist/webview/cosmosView.js',
		logLevel: 'silent',
		plugins: [
			esbuildProblemMatcherPlugin,
		],
		// Cosmos.glはグローバルにロードされるため外部化
		external: ['cosmos'],
	});

	if (watch) {
		await extensionCtx.watch();
		await webviewCtx.watch();
		await cosmosViewCtx.watch();
	} else {
		await extensionCtx.rebuild();
		await webviewCtx.rebuild();
		await cosmosViewCtx.rebuild();
		await extensionCtx.dispose();
		await webviewCtx.dispose();
		await cosmosViewCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
