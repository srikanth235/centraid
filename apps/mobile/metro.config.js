// it macOS would EMFILE. nodeModulesPaths lets the resolver find both this
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules/react-native/node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

// those packages from source, so retry a missing relative `.js` import without
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolve ?? context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (error) {
    if (/^\.{1,2}\/.+\.js$/u.test(moduleName)) {
      return resolve(context, moduleName.slice(0, -3), platform);
    }
    throw error;
  }
};

// run before app code": an import at the top of `index.ts` only wins if nothing
// not enforce ordering there. Expo puts React Native's own polyfills in this
const expoGetPolyfills = config.serializer.getPolyfills;
config.serializer.getPolyfills = (options) => [
  ...(expoGetPolyfills?.(options) ?? []),
  require.resolve("./polyfills/array-to-sorted.js"),
];

module.exports = config;
