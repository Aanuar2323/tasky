import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DESKTOP_DIR = path.join(ROOT, 'apps', 'desktop');
const RESOURCES_DIR = path.join(DESKTOP_DIR, 'dist');

console.log('[prebuild] Copying assets for desktop app...');

fs.rmSync(RESOURCES_DIR, { recursive: true, force: true });
fs.mkdirSync(RESOURCES_DIR, { recursive: true });

copyDir(path.join(ROOT, 'apps', 'api', 'src'), path.join(RESOURCES_DIR, 'apps', 'api', 'src'));

for (const entry of fs.readdirSync(path.join(ROOT, 'node_modules'), { withFileTypes: true })) {
  if (entry.name.startsWith('.')) continue;
  if (entry.name.startsWith('@')) {
    for (const scoped of fs.readdirSync(path.join(ROOT, 'node_modules', entry.name), { withFileTypes: true })) {
      const srcPath = path.join(ROOT, 'node_modules', entry.name, scoped.name);
      const destPath = path.join(RESOURCES_DIR, 'node_modules', entry.name, scoped.name);
      if (scoped.isSymbolicLink()) continue;
      if (scoped.isDirectory()) copyDir(srcPath, destPath);
      else fs.copyFileSync(srcPath, destPath);
    }
  } else if (entry.isSymbolicLink()) {
    continue;
  } else if (entry.isDirectory()) {
    const srcPath = path.join(ROOT, 'node_modules', entry.name);
    const destPath = path.join(RESOURCES_DIR, 'node_modules', entry.name);
    copyDir(srcPath, destPath);
  } else {
    const srcPath = path.join(ROOT, 'node_modules', entry.name);
    const destPath = path.join(RESOURCES_DIR, 'node_modules', entry.name);
    fs.copyFileSync(srcPath, destPath);
  }
}

fs.mkdirSync(path.join(RESOURCES_DIR, 'apps', 'api'), { recursive: true });
const apiPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'api', 'package.json'), 'utf-8'));
fs.writeFileSync(
  path.join(RESOURCES_DIR, 'apps', 'api', 'package.json'),
  JSON.stringify({ ...apiPkg, type: 'module' }, null, 2)
);

const standaloneSrc = path.join(ROOT, 'apps', 'web', '.next', 'standalone');
if (fs.existsSync(standaloneSrc)) {
  copyDir(standaloneSrc, path.join(RESOURCES_DIR, 'web', 'standalone'));
  const staticSrc = path.join(ROOT, 'apps', 'web', '.next', 'static');
  if (fs.existsSync(staticSrc)) {
    copyDir(staticSrc, path.join(RESOURCES_DIR, 'web', 'standalone', 'apps', 'web', '.next', 'static'));
  }
  const publicSrc = path.join(ROOT, 'apps', 'web', 'public');
  if (fs.existsSync(publicSrc)) {
    copyDir(publicSrc, path.join(RESOURCES_DIR, 'web', 'standalone', 'apps', 'web', 'public'));
  }
} else {
  console.warn('[prebuild] Warning: Next standalone not found. Run "npm run build -w apps/web" first.');
}

fs.copyFileSync(
  path.join(DESKTOP_DIR, 'entrypoint.mjs'),
  path.join(RESOURCES_DIR, 'entrypoint.mjs')
);

console.log('[prebuild] Done. Assets in', RESOURCES_DIR);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(srcPath);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        copyDir(target, destPath);
      } else {
        fs.copyFileSync(target, destPath);
      }
    } else if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}