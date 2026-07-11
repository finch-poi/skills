import { existsSync, readdirSync } from 'fs';
import { mkdir, symlink, rm, lstat, readlink, readFile, writeFile } from 'fs/promises';
import { join, resolve, dirname, relative } from 'path';
import { platform } from 'os';
import { agents } from './agents.ts';
import type { AgentType } from './types.ts';

const DEFAULT_CONTEXT_FILE = 'AGENTS.md';

/**
 * Directories to skip when recursively searching for context files.
 * Avoids entering dependency, build-output, and agent symlink directories
 * (mirrors the SKIP_DIRS approach from sync-agents.js).
 */
const SKIP_DIRS = new Set([
  '.git',
  '.idea',
  'node_modules',
  'dist',
  'out',
  'coverage',
  '.agents',
  '.claude',
  '.cursor',
  '.gemini',
  '.copilot',
  '.codeium',
  '.vscode',
  '.windsurf',
  '.roo',
  '.kilocode',
  '.qoder',
  '.qwen',
  '.trae',
  '.codebuddy',
  '.continue',
  '.augment',
  '.forge',
]);

/**
 * A context file link to create: `target` is a symlink pointing to `source`.
 */
export interface ContextLink {
  /** The source file name (e.g., "AGENTS.md") */
  source: string;
  /** The target file name (e.g., "CLAUDE.md") */
  target: string;
}

export interface ContextLinkResult {
  source: string;
  target: string;
  /** Directory where the link was created (relative to cwd) */
  dir: string;
  created: boolean;
  skipped: boolean;
  warning?: string;
}

/**
 * Detect the source context file name in the project root.
 * Checks for AGENTS.md first (the standard), then CLAUDE.md, then GEMINI.md.
 * Returns the first match, or DEFAULT_CONTEXT_FILE if none exist yet.
 */
export function detectContextFile(cwd: string = process.cwd()): string {
  const candidates = [DEFAULT_CONTEXT_FILE, 'CLAUDE.md', 'GEMINI.md'];
  for (const file of candidates) {
    if (existsSync(join(cwd, file))) {
      return file;
    }
  }
  return DEFAULT_CONTEXT_FILE;
}

/**
 * Recursively find all files matching `fileName` under `cwd`.
 * Skips directories listed in SKIP_DIRS (dependencies, build outputs, agent dirs).
 * Returns absolute paths.
 */
export function findContextFiles(fileName: string, cwd: string = process.cwd()): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // Skip hidden directories (config/build dirs)
        if (entry.name.startsWith('.')) continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name === fileName) {
        results.push(fullPath);
      }
    }
  }

  walk(cwd);

  // Always include the root-level file if it exists (walk already covers this,
  // but this ensures root is always checked even if skipped by hidden-dir logic)
  const rootFile = join(cwd, fileName);
  if (existsSync(rootFile) && !results.includes(rootFile)) {
    results.unshift(rootFile);
  }

  return results;
}

/**
 * Derive the context file links needed for the given agents.
 *
 * For each agent, if the agent has a `contextFile` that differs from the
 * source `contextFile`, a link is created: agent's contextFile -> source.
 * Agents whose contextFile matches the source are skipped (no link needed).
 */
export function deriveContextLinks(contextFile: string, agentTypes: AgentType[]): ContextLink[] {
  const links: ContextLink[] = [];
  const seen = new Set<string>();

  for (const agentType of agentTypes) {
    const cfg = agents[agentType];
    if (!cfg?.contextFile) continue;
    const target = cfg.contextFile;
    if (target === contextFile) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    links.push({ source: contextFile, target });
  }

  return links;
}

/**
 * Ensure a single context file symlink exists in the given directory.
 *
 * - If target doesn't exist -> create symlink
 * - If target is already a correct symlink -> skip
 * - If target is a real file (not symlink) -> warn and skip (don't overwrite)
 * - If target is a symlink pointing elsewhere -> remove and recreate
 *
 * @param link - The source/target file names
 * @param sourceDir - Directory containing the source file (where symlink is created)
 * @param cwd - Project root (for computing relative paths in results)
 */
export async function ensureContextLink(
  link: ContextLink,
  sourceDir: string,
  cwd: string = process.cwd()
): Promise<ContextLinkResult> {
  const { source, target } = link;
  const sourcePath = join(sourceDir, source);
  const targetPath = join(sourceDir, target);
  const relDir = relative(cwd, sourceDir) || '.';

  // Source file must exist
  if (!existsSync(sourcePath)) {
    return {
      source,
      target,
      dir: relDir,
      created: false,
      skipped: true,
      warning: `Source file ${source} does not exist in ${relDir}, skipping`,
    };
  }

  // Check target's current state
  try {
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) {
      // Check if it already points to the correct source
      const existingTarget = await readlink(targetPath);
      const resolved = resolve(dirname(targetPath), existingTarget);
      if (resolved === sourcePath) {
        return { source, target, dir: relDir, created: false, skipped: true };
      }
      // Wrong symlink target -- remove and recreate
      await rm(targetPath, { force: true });
    } else if (stat.isFile()) {
      // Real file -- don't overwrite, warn
      return {
        source,
        target,
        dir: relDir,
        created: false,
        skipped: true,
        warning: `${target} in ${relDir} is a real file, not a symlink. Remove it manually if you want to link it to ${source}`,
      };
    }
  } catch {
    // Target doesn't exist -- proceed to create
  }

  // Create the symlink
  try {
    const linkDir = dirname(targetPath);
    await mkdir(linkDir, { recursive: true });

    const isWin = platform() === 'win32';
    // Windows: use absolute path; Unix: relative path for portability
    const symlinkTarget = isWin ? sourcePath : relative(linkDir, sourcePath);

    await symlink(symlinkTarget, targetPath, 'file');
    return { source, target, dir: relDir, created: true, skipped: false };
  } catch {
    return {
      source,
      target,
      dir: relDir,
      created: false,
      skipped: true,
      warning: `Failed to create symlink ${target} -> ${source} in ${relDir} (try running as administrator on Windows)`,
    };
  }
}

/**
 * Add patterns to .gitignore if not already present.
 * Creates the file if it doesn't exist. Groups managed entries under a header.
 */
export async function addToGitignore(
  patterns: string[],
  cwd: string = process.cwd()
): Promise<void> {
  if (patterns.length === 0) return;

  const gitignorePath = join(cwd, '.gitignore');
  let content = '';
  if (existsSync(gitignorePath)) {
    content = await readFile(gitignorePath, 'utf-8');
  }

  const lines = content.split('\n');
  const toAdd = patterns.filter((p) => !lines.includes(p));
  if (toAdd.length === 0) return;

  const header = '# Managed by skills.sh -- agent context file symlinks';
  const hasHeader = lines.some((l) => l.trim() === header);

  let newContent: string;
  if (hasHeader) {
    // Append under existing header
    newContent = content + (content.endsWith('\n') ? '' : '\n') + toAdd.join('\n') + '\n';
  } else {
    // Add header + entries
    newContent =
      content + (content.endsWith('\n') ? '' : '\n') + `\n${header}\n${toAdd.join('\n')}\n`;
  }

  await writeFile(gitignorePath, newContent, 'utf-8');
}

/**
 * Sync context file links for the given agents.
 *
 * 1. Recursively find all source context files (e.g., all AGENTS.md)
 * 2. For each found file, create symlinks for agents whose contextFile differs
 * 3. Add symlink targets to .gitignore (with relative paths)
 *
 * Returns the results for display.
 */
export async function syncContextLinks(
  contextFile: string,
  agentTypes: AgentType[],
  cwd: string = process.cwd()
): Promise<ContextLinkResult[]> {
  // 1. Derive which target files to create (e.g., CLAUDE.md, GEMINI.md)
  const links = deriveContextLinks(contextFile, agentTypes);
  if (links.length === 0) return [];

  // 2. Recursively find all source context files in the project
  const sourcePaths = findContextFiles(contextFile, cwd);

  const results: ContextLinkResult[] = [];
  const gitignorePatterns: string[] = [];

  // 3. For each found source file, create symlinks in the same directory
  for (const sourcePath of sourcePaths) {
    const sourceDir = dirname(sourcePath);
    for (const link of links) {
      const result = await ensureContextLink(link, sourceDir, cwd);
      results.push(result);

      // Collect gitignore patterns (relative to cwd, forward slashes)
      if (result.created) {
        const targetRel = relative(cwd, join(sourceDir, link.target));
        gitignorePatterns.push(targetRel.replace(/\\/g, '/'));
      }
    }
  }

  // 4. Add symlink targets to .gitignore
  if (gitignorePatterns.length > 0) {
    try {
      await addToGitignore(gitignorePatterns, cwd);
    } catch {
      // Don't fail if .gitignore can't be updated
    }
  }

  return results;
}
