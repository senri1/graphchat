#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const RELEASE_DIR = path.join(ROOT, 'release');
const PUBLIC_DIR = path.join(RELEASE_DIR, 'public');
const INSTALLER_RE = /\.(dmg|exe)$/i;

function rel(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function fail(message) {
  console.error(`release:collect FAILED: ${message}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(RELEASE_DIR) || !fs.statSync(RELEASE_DIR).isDirectory()) {
    fail('release/ does not exist. Run dist:mac or dist:win first.');
  }

  const entries = fs.readdirSync(RELEASE_DIR, { withFileTypes: true });
  const installers = entries
    .filter((entry) => entry.isFile() && INSTALLER_RE.test(entry.name))
    .map((entry) => path.join(RELEASE_DIR, entry.name));

  if (installers.length === 0) {
    fail('No installer files (.dmg/.exe) were found in release/.');
  }

  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  for (const src of installers) {
    const dest = path.join(PUBLIC_DIR, path.basename(src));
    fs.copyFileSync(src, dest);
  }

  console.log(`Collected ${installers.length} installer(s) into ${rel(PUBLIC_DIR)}:`);
  for (const installer of installers) {
    console.log(`- ${rel(path.join(PUBLIC_DIR, path.basename(installer)))}`);
  }
}

main();
