## [1.2.2](https://github.com/angristan/opencode-wakatime/compare/v1.2.1...v1.2.2) (2026-02-12)

### Bug Fixes

* skip directories from heartbeat tracking ([dd0f3f2](https://github.com/angristan/opencode-wakatime/commit/dd0f3f22aa4384c9b2b1e2aa0873060c578ba192))

## [1.2.1](https://github.com/angristan/opencode-wakatime/compare/v1.2.0...v1.2.1) (2026-02-12)

### Dependencies

* **deps-dev:** bump @biomejs/biome from 2.3.13 to 2.3.14 ([#32](https://github.com/angristan/opencode-wakatime/issues/32)) ([8253c65](https://github.com/angristan/opencode-wakatime/commit/8253c65beb350fb338c8814210b91dcf8b925a27))
* **deps-dev:** bump @opencode-ai/plugin from 1.1.51 to 1.1.59 ([#31](https://github.com/angristan/opencode-wakatime/issues/31)) ([8a857e2](https://github.com/angristan/opencode-wakatime/commit/8a857e2ce5123b87bcfc4e2419b3bb552237dcf8))
* **deps-dev:** bump @types/node from 25.2.0 to 25.2.3 ([#30](https://github.com/angristan/opencode-wakatime/issues/30)) ([37b29a4](https://github.com/angristan/opencode-wakatime/commit/37b29a4066aff3daf334d19757ab59e1ffc21ee9))
* **deps-dev:** bump esbuild from 0.27.2 to 0.27.3 ([#33](https://github.com/angristan/opencode-wakatime/issues/33)) ([94e3d15](https://github.com/angristan/opencode-wakatime/commit/94e3d15c61f1133aaa4f18f84cc79e257923e873))

## [1.2.0](https://github.com/angristan/opencode-wakatime/compare/v1.1.5...v1.2.0) (2026-02-09)

### Features

* include opencode client type and version in --plugin flag ([f89bf62](https://github.com/angristan/opencode-wakatime/commit/f89bf6254cd83fe492cafde7aa3d72e8f97aa44d)), closes [#24](https://github.com/angristan/opencode-wakatime/issues/24)

## [1.1.5](https://github.com/angristan/opencode-wakatime/compare/v1.1.4...v1.1.5) (2026-02-05)

### Bug Fixes

* **release:** show dependency updates in release notes ([b2ff9c2](https://github.com/angristan/opencode-wakatime/commit/b2ff9c208b60f18c878bac066a76e29cc9471216))

## [1.1.4](https://github.com/angristan/opencode-wakatime/compare/v1.1.3...v1.1.4) (2026-02-05)


### Bug Fixes

* **deps:** resolve node-tar path traversal vulnerability ([0ff40eb](https://github.com/angristan/opencode-wakatime/commit/0ff40eb825c92faf3ade90885ec6da813efbee70))

## [1.1.3](https://github.com/angristan/opencode-wakatime/compare/v1.1.2...v1.1.3) (2026-02-05)

## [1.1.2](https://github.com/angristan/opencode-wakatime/compare/v1.1.1...v1.1.2) (2026-02-05)


### Bug Fixes

* **release:** trigger patch releases for dependabot dependency updates ([d99f61e](https://github.com/angristan/opencode-wakatime/commit/d99f61e37df6ef383b47926858d96deee8f6aabb))

## [1.1.1](https://github.com/angristan/opencode-wakatime/compare/v1.1.0...v1.1.1) (2026-01-09)


### Bug Fixes

* await heartbeats on shutdown to prevent data loss ([bf30005](https://github.com/angristan/opencode-wakatime/commit/bf30005c3a864f7a484e5547b8abd9c9bdf89bc3))
* inline version at build time for correct reporting ([31c1f4c](https://github.com/angristan/opencode-wakatime/commit/31c1f4ce651a6311cdfc8380806b81a63746b772))
* track batch tool operations via message.part.updated event ([283070d](https://github.com/angristan/opencode-wakatime/commit/283070d36197b8c4312731caf8127e1c51daaffc))
* use project-specific state files for rate limiting ([75df507](https://github.com/angristan/opencode-wakatime/commit/75df50704decb337456653a101f298b690eb2784))

# [1.1.0](https://github.com/angristan/opencode-wakatime/compare/v1.0.2...v1.1.0) (2025-12-23)


### Features

* track file reads as coding activity ([558fbbe](https://github.com/angristan/opencode-wakatime/commit/558fbbeb577d333029b022a6f59aa41450ce22e6))

## [1.0.2](https://github.com/angristan/opencode-wakatime/compare/v1.0.1...v1.0.2) (2025-12-23)


### Bug Fixes

* ensure plugin works with Bun runtime ([07b419f](https://github.com/angristan/opencode-wakatime/commit/07b419f0edc9b8efe610d39f7bcb35b27b117ff3))

## [1.0.1](https://github.com/angristan/opencode-wakatime/compare/v1.0.0...v1.0.1) (2025-12-23)


### Bug Fixes

* read version from package.json instead of hardcoding ([a1578ed](https://github.com/angristan/opencode-wakatime/commit/a1578ed574438966d3a98999ff2d4ba5ea1b1ba8))

# 1.0.0 (2025-12-23)


### Bug Fixes

* update OpenCode repository link ([b96d829](https://github.com/angristan/opencode-wakatime/commit/b96d8297077a46d70ab14ad0e0de8dbb819a931f))


### Features

* add CLI for npm-based installation ([6868ece](https://github.com/angristan/opencode-wakatime/commit/6868ece59da15368be5d1f59dc1c1539017795d1))
