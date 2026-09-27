import { v1Plugin } from "./v1.js";
import { setupV2 } from "./v2.js";

// Plugin.define is an identity function; no runtime SDK import is needed.
export default {
  id: "opencode.wakatime",
  server: v1Plugin,
  setup: setupV2,
};
