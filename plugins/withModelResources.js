// adds the .pte model to the iOS app bundle as an Xcode resource instead of a Metro asset.
// Metro reads an asset into one JS string, capped near 512 MB, and the export is larger.
// the small tokenizer files stay Metro assets
const fs = require('node:fs');
const path = require('node:path');

const MODEL_DIR = path.join('assets', 'model');

const MODEL_EXT = '.pte';

// expo-asset files its resources under this group too, so there is one group, not two
const GROUP_NAME = 'Resources';

// pure apart from the injected fs readers, so it runs in node tests
function resolveModelResources({
  projectRoot,
  platformProjectRoot,
  files,
  listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
  fileExists = (file) => fs.existsSync(file),
}) {
  const modelDir = path.join(projectRoot, MODEL_DIR);

  let names;
  if (files === undefined) {
    // sorted so the pbxproj is identical across machines. readdir order depends on the filesystem
    names = listDir(modelDir)
      .filter((name) => name.endsWith(MODEL_EXT))
      .sort();
  } else {
    if (!Array.isArray(files)) {
      throw new Error("withModelResources: the `files` option must be an array of file names under assets/model/.");
    }
    names = files.map((entry) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new Error('withModelResources: every entry in `files` must be a non-empty file name.');
      }
      // a name, not a path. the LFS rule and the pointer check assume nothing outside assets/model/
      if (path.basename(entry) !== entry) {
        throw new Error(
          `withModelResources: \`files\` entries are names inside ${MODEL_DIR}, not paths. Got "${entry}".`,
        );
      }
      if (!entry.endsWith(MODEL_EXT)) {
        throw new Error(`withModelResources: "${entry}" is not a ${MODEL_EXT} file.`);
      }
      return entry;
    });
  }

  return names.map((name) => {
    const absolutePath = path.join(modelDir, name);
    if (!fileExists(absolutePath)) {
      // fail the build, or the app ships with no model and it only shows up on a device
      throw new Error(
        `withModelResources: ${path.join(MODEL_DIR, name)} does not exist. Run \`git lfs pull\`, or export the artifact first.`,
      );
    }
    return {
      name,
      absolutePath,
      // a "<group>" reference resolves against the .xcodeproj directory, so this is relative to ios/
      filepath: path.relative(platformProjectRoot, absolutePath).split(path.sep).join('/'),
    };
  });
}

// options.files lists the .pte names to ship. app.json passes it because assets/model/
// holds several exports while choosing a model, and only one belongs in the app
function withModelResources(config, options = {}) {
  // required here, not at module scope, so tests can load the helper without Xcode tooling
  const { IOSConfig, withXcodeProject } = require('expo/config-plugins');

  return withXcodeProject(config, (xcodeConfig) => {
    const project = xcodeConfig.modResults;
    const resources = resolveModelResources({
      projectRoot: xcodeConfig.modRequest.projectRoot,
      platformProjectRoot: xcodeConfig.modRequest.platformProjectRoot,
      files: options.files,
    });

    IOSConfig.XcodeUtils.ensureGroupRecursively(project, GROUP_NAME);
    for (const resource of resources) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: resource.filepath,
        groupName: GROUP_NAME,
        project,
        isBuildFile: true,
        verbose: true,
      });
    }

    return xcodeConfig;
  });
}

module.exports = withModelResources;
module.exports.withModelResources = withModelResources;
module.exports.resolveModelResources = resolveModelResources;
module.exports.MODEL_DIR = MODEL_DIR;
module.exports.MODEL_EXT = MODEL_EXT;
module.exports.GROUP_NAME = GROUP_NAME;
