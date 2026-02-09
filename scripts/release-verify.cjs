#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const RELEASE_DIR = path.join(ROOT, 'release');

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.html',
  '.css',
  '.txt',
  '.md',
  '.yml',
  '.yaml',
  '.map',
  '.xml',
]);

const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const FAILURES = [];
const WARNINGS = [];

function rel(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function existsDir(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(absDir) {
  const out = [];
  const stack = [absDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

function shouldScanFile(absPath, sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_SCAN_BYTES) return false;
  const ext = path.extname(absPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const base = path.basename(absPath);
  if (base === 'builder-debug.yml' || base === 'builder-effective-config.yaml') return true;
  return false;
}

function findMatches(text, re, limit = 3) {
  re.lastIndex = 0;
  const out = [];
  let m = null;
  while ((m = re.exec(text)) !== null) {
    out.push(String(m[0]));
    if (out.length >= limit) break;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskMatch(value) {
  const s = String(value ?? '');
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function addFailure(kind, filePath, matches) {
  FAILURES.push({
    kind,
    file: rel(filePath),
    matches: Array.from(new Set(matches.map(maskMatch))).slice(0, 3),
  });
}

function checkGitTracking() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: ROOT, stdio: 'ignore' });
  } catch {
    WARNINGS.push('Git metadata unavailable; skipped tracked-file checks.');
    return;
  }
  try {
    execSync('git ls-files --error-unmatch .env.local', { cwd: ROOT, stdio: 'ignore' });
    FAILURES.push({
      kind: 'tracked-secret-file',
      file: '.env.local',
      matches: ['.env.local is tracked by git'],
    });
  } catch {
    // Expected when not tracked.
  }
}

function checkReleaseArtifacts(releaseFiles) {
  const installers = releaseFiles.filter((f) => /\.(dmg|exe)$/i.test(f));
  if (installers.length === 0) {
    FAILURES.push({
      kind: 'missing-installers',
      file: 'release',
      matches: ['No .dmg or .exe installers found in release/.'],
    });
    return;
  }
  const listed = installers.map((f) => rel(f)).slice(0, 8);
  console.log(`Found installer artifacts (${installers.length}):`);
  for (const item of listed) console.log(`- ${item}`);
  if (installers.length > listed.length) {
    console.log(`- ... and ${installers.length - listed.length} more`);
  }
}

function scanFiles(files) {
  const localRootNormalized = ROOT.split(path.sep).join('/');
  const projectRootPattern = new RegExp(escapeRegExp(localRootNormalized), 'g');
  const usernames = Array.from(
    new Set(
      [os.userInfo()?.username, process.env.USER, process.env.USERNAME]
        .map((v) => String(v ?? '').trim())
        .filter(Boolean),
    ),
  );

  const localPathPatterns = [];
  for (const username of usernames) {
    const escaped = escapeRegExp(username);
    localPathPatterns.push(new RegExp(`/Users/${escaped}(?:/[^\\s"']+)*`, 'g'));
    localPathPatterns.push(new RegExp(`/home/${escaped}(?:/[^\\s"']+)*`, 'g'));
    localPathPatterns.push(new RegExp(`[A-Za-z]:\\\\\\\\Users\\\\\\\\${escaped}(?:\\\\\\\\[^\\s"']+)*`, 'g'));
  }

  const checks = [
    {
      kind: 'secret-like-token',
      re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    },
    {
      kind: 'secret-like-token',
      re: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    },
    {
      kind: 'project-root-path',
      re: projectRootPattern,
    },
  ];

  for (const re of localPathPatterns) {
    checks.push({
      kind: 'local-absolute-path',
      re,
    });
  }

  for (const absPath of files) {
    let stat = null;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }

    if (!shouldScanFile(absPath, stat.size)) {
      if (stat.size > MAX_SCAN_BYTES) {
        WARNINGS.push(`Skipped large file (>8MB): ${rel(absPath)}`);
      }
      continue;
    }

    let text = '';
    try {
      text = fs.readFileSync(absPath, 'utf8');
    } catch {
      WARNINGS.push(`Skipped unreadable text file: ${rel(absPath)}`);
      continue;
    }

    for (const check of checks) {
      const matches = findMatches(text, check.re);
      if (matches.length > 0) addFailure(check.kind, absPath, matches);
    }
  }
}

function main() {
  console.log('Running release verification...');

  if (!existsDir(DIST_DIR)) {
    FAILURES.push({
      kind: 'missing-dist',
      file: 'dist',
      matches: ['dist/ does not exist. Run a build before release verification.'],
    });
  }
  if (!existsDir(RELEASE_DIR)) {
    FAILURES.push({
      kind: 'missing-release',
      file: 'release',
      matches: ['release/ does not exist. Run dist:mac or dist:win first.'],
    });
  }

  checkGitTracking();

  const distFiles = existsDir(DIST_DIR) ? walkFiles(DIST_DIR) : [];
  const releaseFiles = existsDir(RELEASE_DIR) ? walkFiles(RELEASE_DIR) : [];

  if (releaseFiles.some((f) => path.basename(f) === '.DS_Store')) {
    WARNINGS.push('Found .DS_Store in release/. Consider removing it before upload.');
  }

  if (releaseFiles.length > 0) checkReleaseArtifacts(releaseFiles);

  scanFiles(distFiles);
  scanFiles(releaseFiles);

  if (FAILURES.length > 0) {
    console.error('\nrelease:verify FAILED');
    console.error('Potential leak or packaging issues detected:');
    for (const item of FAILURES) {
      console.error(`- [${item.kind}] ${item.file}: ${item.matches.join(' | ')}`);
    }
    if (WARNINGS.length > 0) {
      console.error('\nWarnings:');
      for (const warning of WARNINGS) console.error(`- ${warning}`);
    }
    process.exit(1);
    return;
  }

  console.log('\nrelease:verify PASSED');
  console.log('No obvious secret tokens or local machine paths were found in scanned artifacts.');
  if (WARNINGS.length > 0) {
    console.log('\nWarnings:');
    for (const warning of WARNINGS) console.log(`- ${warning}`);
  }
}

main();
