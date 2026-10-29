import { Language } from '../common/types';
import * as fs from 'fs';
import * as path from 'path';
import languages from '../common/languages.json';

// 개발 모듈과 번들이 노출하는 Parser 내보내기 형식을 함께 지원한다.
const webTreeSitter = require('web-tree-sitter');
const Parser = webTreeSitter.Parser ?? webTreeSitter.default ?? webTreeSitter;

// 문법을 반복 로드하면 WASM 함수 테이블이 고갈된다. 불변 문법은 프로세스에서 공유한다.
const grammarCache = new Map<string, Promise<any>>();
const languageByExtension = new Map<string, Language>(Object.entries(languages).flatMap(([language, config]) =>
    config.extensions.map(extension => [extension, language as Language] as const)));

/** 번들에 포함된 Tree-sitter WASM으로 코드를 파싱한다. */
export class CodeParser {
    private parser: any | null = null;
    private initialized = false;
    private langCache = new Map<Language, any>();

    /** 요청된 문법과 보조 문법만 준비하며 생략하면 기존 전체 초기화를 유지한다. */
    public async initialize(extensionPath?: string, requestedLanguages: readonly Language[] = Object.keys(languages) as Language[]): Promise<void> {
        if (this.initialized && requestedLanguages.every(language => this.langCache.has(language) || !languages[language].grammar)) return;
        if (extensionPath && !fs.existsSync(extensionPath)) throw new Error(`파서 자산 경로가 없습니다: ${extensionPath}`);
        if (!this.initialized) {
            await Parser.init();
            this.parser = new Parser();
            this.initialized = true;
        }
        // Language는 런타임 초기화가 끝난 뒤에 접근해야 한다.
        const Language = Parser.Language ?? webTreeSitter.Language;

        if (!extensionPath) {
            // 직접 파서를 호출하는 검사의 기본 자산 경로다.
            extensionPath = path.resolve(__dirname, '../../');
        }

        // 배포 자산을 우선하고 개발 환경에서는 설치된 문법을 사용한다.
        const packagedWasmDir = path.join(extensionPath, 'dist', 'wasm');
        const packaged = fs.existsSync(path.join(packagedWasmDir, 'tree-sitter-javascript.wasm'));

        try {
            const required = new Set(requestedLanguages);
            for (const language of requestedLanguages) {
                if (language === 'c' || language === 'objcpp') required.add('cpp');
                if (['vue', 'svelte', 'astro', 'ejs'].includes(language)) {
                    required.add('javascript');
                    required.add('typescript');
                }
            }
            for (const language of required) {
                const config = languages[language];
                if (!config.grammar || this.langCache.has(language)) continue;
                const filename = `tree-sitter-${config.grammar}.wasm`;
                const source = 'wasm' in config ? config.wasm : `tree-sitter-wasms/out/${filename}`;
                const bundledFile = path.join(packagedWasmDir, filename);
                const wasmPath = packaged && fs.existsSync(bundledFile) ? bundledFile : path.join(extensionPath, 'node_modules', source);
                if (!grammarCache.has(wasmPath)) {
                    grammarCache.set(wasmPath, Language.load(wasmPath).catch((error: unknown) => {
                        grammarCache.delete(wasmPath);
                        throw error;
                    }));
                }
                this.langCache.set(language, await grammarCache.get(wasmPath));
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
            console.error(`${language} 구문 분석 실패:`, e);
            return null;
        }
    }

    /** 파서 자원을 해제하며 불변 문법은 다음 색인에서도 재사용한다. */
    public dispose(): void {
        this.parser?.delete();
        this.parser = null;
        this.langCache.clear();
        this.initialized = false;
    }

    /** 지원하는 소스 확장자를 언어 이름으로 변환한다. */
    public static getLanguageFromFile(filePath: string): Language | null {
        // 생성된 의존성 잠금 파일의 수천 개 키가 코드 그래프를 채우지 않게 한다.
        if (['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock'].includes(path.basename(filePath).toLowerCase())) return null;
        const extension = path.extname(filePath);
        if (extension === '.C' || extension === '.H') return 'cpp';
        return languageByExtension.get(extension.toLowerCase()) || null;
    }
}
