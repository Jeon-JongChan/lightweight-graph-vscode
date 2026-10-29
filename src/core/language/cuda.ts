import { CppAnalyzer } from './cpp';
import { LanguageAnalyzer } from './base';
/** CUDA의 부분 지원 범위인 C++ 선언·일반 호출 규칙을 선택한다. */
export function createAnalyzer(): LanguageAnalyzer { return new CppAnalyzer('cuda'); }
