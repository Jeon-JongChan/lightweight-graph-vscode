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
    cuda
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
