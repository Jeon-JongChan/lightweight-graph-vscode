import { LanguageAnalyzer } from './base';
import { TypescriptAnalyzer } from './typescript';
/** TSX 문법과 TypeScript의 선언·호출 규칙을 연결한다. */
export function createAnalyzer(): LanguageAnalyzer { return new TypescriptAnalyzer('tsx'); }
