// Metro config for the mobile workspace — standard Expo monorepo setup.
// Watching the whole workspace works because watchman is installed; without
// it macOS would EMFILE. nodeModulesPaths lets the resolver find both this
// package's own deps and ones hoisted to the root.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
