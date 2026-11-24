// Test-only predecessor. Obsidian loads this plugin and stores a version-0 configuration
// before the harness replaces the three installed files with the real release assets.
const { Plugin } = require("obsidian");

module.exports = class UpgradeFixture extends Plugin {
  async prepareUpgrade(cfg) {
    await this.saveData({ ...cfg, version: 0 });
  }
};
