import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// read minAppVersion from manifest.json and bump version to target version
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));

// update version in README.md
let readme = readFileSync("README.md", "utf8");
readme = readme.replace(/\*\*Version\*\*:\s*\d+\.\d+\.\d+/g, `**Version**: ${targetVersion}`);
writeFileSync("README.md", readme);

// update version in README.ru.md
let readmeRu = readFileSync("README.ru.md", "utf8");
readmeRu = readmeRu.replace(/\*\*Версия\*\*:\s*\d+\.\d+\.\d+/g, `**Версия**: ${targetVersion}`);
writeFileSync("README.ru.md", readmeRu);
