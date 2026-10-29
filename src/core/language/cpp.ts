import { Language } from '../../common/types';
import { CAnalyzer } from './c';
import { LanguageAnalyzer } from './base';
/** C++의 클래스·네임스페이스 선언과 암묵적 멤버 호출 정책을 담당한다. */
export class CppAnalyzer extends CAnalyzer {
    /** C 선언자와 include를 공유하고 C++ 문법 및 암묵적 this를 선택한다. */
    constructor(language: Language = 'cpp') { super(language, true); }
}
/** C++의 실제 선언·관계 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new CppAnalyzer(); }
