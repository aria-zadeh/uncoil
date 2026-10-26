const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// the exported model program is an opaque binary. metro will not resolve
// require() of an unknown extension, so register it even before the file exists
config.resolver.assetExts.push("pte");

// tokenizer files are plain JSON but not named `.json`: metro treats `.json` as
// source and would parse 3.5 MB of vocabulary into the bundle on every launch.
// the executorch fetcher reads and parses them itself, so an asset works the same.
// `.json` stays a source extension because changing it affects every dependency
config.resolver.assetExts.push("rnejson");

module.exports = withNativeWind(config, { input: "./global.css" });
