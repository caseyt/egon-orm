/**
 * `@egon-orm/cli`: the `egon` command (migrations and development databases)
 * and the helper that types its configuration file.
 *
 * @module
 */
export { type CliIo, run } from "./cli.js";
export { defineConfig, type EgonConfig, type MigrationsConfig } from "./config.js";
export { VERSION } from "./version.js";
