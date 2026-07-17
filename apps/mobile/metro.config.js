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

// Workspace packages are authored as TypeScript ESM and keep `.js` in their
// relative specifiers so the emitted Node build is executable. Metro consumes
// those packages from source, so retry a missing relative `.js` import without
// its extension and let Metro select the sibling `.ts`/`.tsx` source file.
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolve ?? context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (error) {
    if (/^\.{1,2}\/.+\.js$/.test(moduleName)) {
      return resolve(context, moduleName.slice(0, -3), platform);
    }
    throw error;
  }
};

module.exports = config;
