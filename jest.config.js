const nextJest = require('next/jest');

const createJestConfig = nextJest({
  dir: './',
});

const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^d3-(.*)$': '<rootDir>/node_modules/d3-$1/dist/d3-$1.min.js'
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(d3-scale|d3-shape|d3-array|d3-interpolate|d3-time|internmap)/)'
  ],
};

module.exports = createJestConfig(customJestConfig);
