/** Jest 配置：只编译运行 TypeScript 测试，根目录小程序源码由开发者工具负责编译 */
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['**/tests/**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        diagnostics: false, // 小程序全局 API 的类型由 tools/types 提供，类型问题不阻断测试
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['../utils/**/*.ts'],
};
