module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/.test/*.test.ts'],
  // 생성된 패키지·성능 기준본은 검사 대상과 모듈 색인에서 제외한다.
  modulePathIgnorePatterns: ['[/\\\\]\\.test[/\\\\][^/\\\\]+[/\\\\]'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'CommonJS', moduleResolution: 'Node10' } }] },
};
