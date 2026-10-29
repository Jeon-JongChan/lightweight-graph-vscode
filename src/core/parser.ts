import { Language } from '../common/types';
import * as fs from 'fs';
import * as path from 'path';
import languages from '../common/languages.json';

// Using commonjs require to bypass TS module resolution issues with web-tree-sitter.
// web-tree-sitter exposes the Parser class as a named export; normalize so this
// works both from node_modules and from the esbuild bundle.
const webTreeSitter = require('web-tree-sitter');
const Parser = webTreeSitter.Parser ?? webTreeSitter.default ?? webTreeSitter;

/** 번들에 포함된 Tree-sitter WASM으로 코드를 파싱한다. */
export class CodeParser {
    private parser: any | null = null;
    private initialized = false;
    private langCache = new Map<Language, any>();

    /** 실행 환경의 문법 WASM을 로드한다. */
    public async initialize(extensionPath?: string): Promise<void> {
        if (this.initialized) return;

        await Parser.init();
        // Language is attached to Parser only after init() completes, so it
        // must be resolved here rather than at module load time.
        const Language = Parser.Language ?? webTreeSitter.Language;
        this.parser = new Parser();

        if (!extensionPath) {
            // Test environment fallback
            extensionPath = path.resolve(__dirname, '../../');
        }

        // Packaged layout: grammar WASM files are bundled into dist/wasm.
        // Dev layout: they live in node_modules/tree-sitter-wasms/out.
        const packagedWasmDir = path.join(extensionPath, 'dist', 'wasm');
        const devWasmDir = path.join(extensionPath, 'node_modules', 'tree-sitter-wasms', 'out');
        const wasmDir = fs.existsSync(path.join(packagedWasmDir, 'tree-sitter-javascript.wasm')) ? packagedWasmDir : devWasmDir;

        try {
            for (const [language, config] of Object.entries(languages)) {
                this.langCache.set(language as Language,
                    await Language.load(path.join(wasmDir, `tree-sitter-${config.grammar}.wasm`)));
            }
            this.initialized = true;
        } catch (e) {
            this.dispose();
            throw new Error(`문법 WASM 로드 실패: ${e}`);
        }
    }

    /** 언어에 맞는 구문 트리를 생성한다. 호출자가 트리를 해제한다. */
    public parse(content: string, language: Language): any | null {
        if (!this.parser || !this.langCache.has(language)) return null;

        try {
            const lang = this.langCache.get(language)!;
            this.parser.setLanguage(lang);
            return this.parser.parse(content);
        } catch (e) {
            console.error(`Failed to parse ${language} code:`, e);
            return null;
        }
    }

    /** 파서와 문법의 WASM 자원을 해제한다. */
    public dispose(): void {
        this.parser?.delete();
        this.parser = null;
        for (const language of this.langCache.values()) language.delete?.();
        this.langCache.clear();
        this.initialized = false;
    }

    /** 지원하는 소스 확장자를 언어 이름으로 변환한다. */
    public static getLanguageFromFile(filePath: string): Language | null {
        const extension = path.extname(filePath);
        if (extension === '.C' || extension === '.H') return 'cpp';
        for (const [language, config] of Object.entries(languages)) {
            if (config.extensions.includes(extension.toLowerCase())) return language as Language;
        }
        return null;
    }
}
