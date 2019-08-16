const {defaults} = require('jest-config');
module.exports = {
  clearMocks: true,
  coverageDirectory: "coverage",
  testEnvironment: "node",
  runner: 'ttypescript',
  moduleFileExtensions: [...defaults.moduleFileExtensions, 'js', 'ts', 'node'],
  testMatch: ['<rootDir>/test/**/*.spec.ts']
};
