const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const languages = require("./src/common/languages.json");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    /** 위치 정보가 없는 빌드 오류도 원래 메시지를 보존해 출력한다. */
    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

// WASM assets cannot be bundled into JS; copy only the files the runtime
// actually loads so the packaged extension does not need node_modules.
// - tree-sitter.wasm (the web-tree-sitter runtime) must sit next to each
//   bundle that loads the parser (the Emscripten glue resolves it relative
//   to the bundle file).
// - Grammar WASM files are loaded by src/core/parser.ts from dist/wasm.
const wasmAssets = [
    ['node_modules/web-tree-sitter/tree-sitter.wasm', 'dist/extension/tree-sitter.wasm'],
    ['node_modules/web-tree-sitter/tree-sitter.wasm', 'dist/mcp/tree-sitter.wasm'],
    ...Object.values(languages).filter(language => language.grammar).filter((language, index, all) => all.findIndex(other => other.grammar === language.grammar) === index).map(language => [
        `node_modules/${language.wasm || `tree-sitter-wasms/out/tree-sitter-${language.grammar}.wasm`}`,
        `dist/wasm/tree-sitter-${language.grammar}.wasm`
    ]),
];

/** 지원 언어 목록에 있는 문법만 번들에 복사한다. */
function copyWasmAssets() {
    for (const [src, dest] of wasmAssets) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
    console.log('[assets] wasm files copied to dist/');
}

/** 확장과 stdio 서버를 별도 번들로 생성한다. */
async function main() {
    const extensionCtx = await esbuild.context({
        entryPoints: ['src/extension/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/extension/extension.js',
        external: ['vscode'],
        logLevel: 'silent',
        plugins: [
            esbuildProblemMatcherPlugin,
        ],
    });

    const mcpCtx = await esbuild.context({
        entryPoints: ['src/mcp/server.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/mcp/server.js',
        external: [],
        logLevel: 'silent',
        plugins: [
            esbuildProblemMatcherPlugin,
        ],
    });

    copyWasmAssets();

    if (watch) {
        await extensionCtx.watch();
        await mcpCtx.watch();
    } else {
        await extensionCtx.rebuild();
        await mcpCtx.rebuild();
        await extensionCtx.dispose();
        await mcpCtx.dispose();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
