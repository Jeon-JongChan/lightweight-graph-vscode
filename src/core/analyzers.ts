import { Language } from '../common/types';
import { LanguageAnalyzer, LanguageAnalysis } from './language/base';
import { CodeParser } from './parser';
export { LanguageAnalyzer, LanguageAnalysis, AstLanguageAnalyzer } from './language/base';
import { createAnalyzer as javascript } from './language/javascript';
import { createAnalyzer as typescript } from './language/typescript';
import { createAnalyzer as tsx } from './language/tsx';
import { createAnalyzer as python } from './language/python';
import { createAnalyzer as java } from './language/java';
import { createAnalyzer as go } from './language/go';
import { createAnalyzer as rust } from './language/rust';
import { createAnalyzer as c } from './language/c';
import { createAnalyzer as cpp } from './language/cpp';
import { createAnalyzer as csharp } from './language/csharp';
import { createAnalyzer as objc } from './language/objc';
import { createAnalyzer as objcpp } from './language/objcpp';
import { createAnalyzer as cuda } from './language/cuda';
import { ExtendedLanguageAnalyzer } from './language/extended';
import { StructuredLanguageAnalyzer } from './language/structured';
import { ComponentLanguageAnalyzer } from './language/components';
import { TextLanguageAnalyzer } from './language/text';
// 언어 설정에 키를 추가하고 생성 함수를 빠뜨리면 타입 검사가 실패한다.
const ANALYZER_FACTORIES = {
    javascript,
    typescript,
    tsx,
    python,
    java,
    go,
    rust,
    c,
    cpp,
    csharp,
    objc,
    objcpp,
    cuda,
    ruby: () => new ExtendedLanguageAnalyzer('ruby'),
    kotlin: () => new ExtendedLanguageAnalyzer('kotlin'),
    scala: () => new ExtendedLanguageAnalyzer('scala'),
    php: () => new ExtendedLanguageAnalyzer('php'),
    swift: () => new ExtendedLanguageAnalyzer('swift'),
    lua: () => new ExtendedLanguageAnalyzer('lua'),
    zig: () => new ExtendedLanguageAnalyzer('zig'),
    powershell: () => new ExtendedLanguageAnalyzer('powershell'),
    elixir: () => new ExtendedLanguageAnalyzer('elixir'),
    julia: () => new ExtendedLanguageAnalyzer('julia'),
    groovy: () => new ExtendedLanguageAnalyzer('groovy'),
    dart: () => new ExtendedLanguageAnalyzer('dart'),
    fortran: () => new ExtendedLanguageAnalyzer('fortran'),
    bash: () => new ExtendedLanguageAnalyzer('bash'),
    r: () => new ExtendedLanguageAnalyzer('r'),
    ocaml: () => new ExtendedLanguageAnalyzer('ocaml'),
    ocaml_interface: () => new ExtendedLanguageAnalyzer('ocaml_interface'),
    commonlisp: () => new ExtendedLanguageAnalyzer('commonlisp'),
    erlang: () => new ExtendedLanguageAnalyzer('erlang'),
    solidity: () => new ExtendedLanguageAnalyzer('solidity'),
    verilog: () => new ExtendedLanguageAnalyzer('verilog'),
    pascal: () => new ExtendedLanguageAnalyzer('pascal'),
    razor: () => new ExtendedLanguageAnalyzer('razor'),
    apex: () => new ExtendedLanguageAnalyzer('apex'),
    vue: () => new ComponentLanguageAnalyzer('vue'),
    svelte: () => new ComponentLanguageAnalyzer('svelte'),
    astro: () => new ComponentLanguageAnalyzer('astro'),
    ejs: () => new ComponentLanguageAnalyzer('ejs'),
    json: () => new StructuredLanguageAnalyzer('json'),
    yaml: () => new StructuredLanguageAnalyzer('yaml'),
    terraform: () => new StructuredLanguageAnalyzer('terraform'),
    sql: () => new StructuredLanguageAnalyzer('sql'),
    xml: () => new StructuredLanguageAnalyzer('xml'),
    markdown: () => new StructuredLanguageAnalyzer('markdown'),
    sln: () => new TextLanguageAnalyzer('sln'),
    vbnet: () => new TextLanguageAnalyzer('vbnet'),
    cobol: () => new TextLanguageAnalyzer('cobol'),
    dreammaker: () => new TextLanguageAnalyzer('dreammaker'),
    dmi: () => new TextLanguageAnalyzer('dmi'),
    robot: () => new TextLanguageAnalyzer('robot'),
    delphi_form: () => new TextLanguageAnalyzer('delphi_form')
} satisfies Record<Language, () => LanguageAnalyzer>;
const analyzers = new Map<Language, LanguageAnalyzer>();
/** 언어별 팩토리를 선택하고 파일별 상태가 없는 분석 전략을 재사용한다. */
export function getLanguageAnalyzer(language: Language): LanguageAnalyzer {
    const existing = analyzers.get(language);
    if (existing)
        return existing;
    const analyzer = ANALYZER_FACTORIES[language]();
    analyzers.set(language, analyzer);
    return analyzer;
}
/** 팩토리 선택과 실제 언어 전략 실행을 묶는 파일 분석 파사드다. */
export function analyzeFile(language: Language, content: string, filePath: string, parser: CodeParser): LanguageAnalysis {
    return getLanguageAnalyzer(language).analyze(content, filePath, parser);
}
