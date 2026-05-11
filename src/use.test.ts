import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCli } from './test-utils.ts';
import { buildUsePrompt, materializeUseSkill, parseUseOptions, type UseSkill } from './use.ts';

describe('use command', () => {
  let testDir: string;
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `skills-use-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('parseUseOptions', () => {
    it('parses owner/repo@skill as the source', () => {
      const result = parseUseOptions(['vercel-labs/agent-skills@nextjs']);

      expect(result.source).toEqual(['vercel-labs/agent-skills@nextjs']);
      expect(result.options.skill).toBeUndefined();
      expect(result.errors).toEqual([]);
    });

    it('parses --skill and -s selectors', () => {
      const longFlag = parseUseOptions(['vercel-labs/agent-skills', '--skill', 'nextjs']);
      const shortFlag = parseUseOptions(['vercel-labs/agent-skills', '-s', 'nextjs']);

      expect(longFlag.options.skill).toBe('nextjs');
      expect(shortFlag.options.skill).toBe('nextjs');
      expect(longFlag.errors).toEqual([]);
      expect(shortFlag.errors).toEqual([]);
    });

    it('rejects repeated skill selectors and unknown flags', () => {
      const result = parseUseOptions([
        'vercel-labs/agent-skills',
        '--skill',
        'one',
        '--skill',
        'two',
        '--wat',
      ]);

      expect(result.errors).toContain('Only one --skill value can be provided');
      expect(result.errors).toContain('Unknown option: --wat');
    });
  });

  describe('buildUsePrompt', () => {
    it('inlines SKILL.md without support directory when there are no supporting files', () => {
      const prompt = buildUsePrompt({
        skillMd: '# Skill\nDo the thing.',
        hasSupportingFiles: false,
      });

      expect(prompt).toContain('<SKILL.md>\n# Skill\nDo the thing.\n</SKILL.md>');
      expect(prompt).not.toContain('Supporting files for this skill were downloaded to:');
    });

    it('includes support directory when supporting files exist', () => {
      const prompt = buildUsePrompt({
        skillMd: '# Skill',
        supportDir: '/tmp/skills-use-abc/my-skill',
        hasSupportingFiles: true,
      });

      expect(prompt).toContain('/tmp/skills-use-abc/my-skill');
      expect(prompt).toContain('When the SKILL.md references relative paths');
    });
  });

  describe('materializeUseSkill', () => {
    it('writes blob-shaped files to a skills-use temp directory', async () => {
      const skill: UseSkill = {
        kind: 'blob',
        name: 'Blob Skill',
        directoryName: 'Blob Skill',
        rawContent: '# Blob Skill',
        files: [
          { path: 'SKILL.md', contents: '# Blob Skill' },
          { path: 'scripts/run.sh', contents: 'echo hi' },
        ],
      };

      const materialized = await materializeUseSkill(skill);
      cleanupDirs.push(materialized.tempRoot);

      expect(materialized.skillDir).toContain('skills-use-');
      expect(readFileSync(join(materialized.skillDir, 'scripts', 'run.sh'), 'utf-8')).toBe(
        'echo hi'
      );
      expect(materialized.hasSupportingFiles).toBe(true);
    });

    it('writes well-known-shaped files to a skills-use temp directory', async () => {
      const skill: UseSkill = {
        kind: 'well-known',
        name: 'Well Known Skill',
        directoryName: 'well-known-skill',
        rawContent: '# Well Known Skill',
        files: new Map([
          ['SKILL.md', '# Well Known Skill'],
          ['reference.md', 'Reference'],
        ]),
      };

      const materialized = await materializeUseSkill(skill);
      cleanupDirs.push(materialized.tempRoot);

      expect(readFileSync(join(materialized.skillDir, 'reference.md'), 'utf-8')).toBe('Reference');
      expect(materialized.hasSupportingFiles).toBe(true);
    });
  });

  describe('CLI behavior', () => {
    it('prints only the generated prompt for a single local skill', () => {
      writeSkill(join(testDir, 'single'), 'single-skill', 'Single skill body.');

      const result = runCli(['use', testDir], testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('You are being given a Skill');
      expect(result.stdout).toContain('Single skill body.');
      expect(result.stdout).not.toContain('████');
      expect(result.stdout).not.toContain('skills add');
    });

    it('includes a temp directory only when supporting files exist', () => {
      const skillDir = writeSkill(
        join(testDir, 'skills', 'with-files'),
        'with-files',
        'Use script.'
      );
      mkdirSync(join(skillDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillDir, 'scripts', 'run.sh'), 'echo with-files');

      const result = runCli(['use', testDir, '--skill', 'with-files'], testDir);
      const supportDir = extractSupportDir(result.stdout);
      if (supportDir) cleanupDirs.push(join(supportDir, '..'));

      expect(result.exitCode).toBe(0);
      expect(supportDir).toBeTruthy();
      expect(existsSync(join(supportDir!, 'scripts', 'run.sh'))).toBe(true);
    });

    it('omits the temp directory section for a skill with only SKILL.md', () => {
      writeSkill(join(testDir, 'single'), 'single-skill', 'Only instructions.');

      const result = runCli(['use', testDir], testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Supporting files for this skill were downloaded to:');
    });

    it('fails with available names when multiple skills have no selector', () => {
      writeSkill(join(testDir, 'skills', 'one'), 'one', 'One.');
      writeSkill(join(testDir, 'skills', 'two'), 'two', 'Two.');

      const result = runCli(['use', testDir], testDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('This source contains multiple skills');
      expect(result.stderr).toContain('one');
      expect(result.stderr).toContain('two');
    });

    it('selects a local skill with --skill', () => {
      writeSkill(join(testDir, 'skills', 'one'), 'one', 'One.');
      writeSkill(join(testDir, 'skills', 'two'), 'two', 'Two.');

      const result = runCli(['use', testDir, '--skill', 'two'], testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Two.');
      expect(result.stdout).not.toContain('One.');
    });

    it('fails for conflicting @skill and --skill selectors before downloading', () => {
      const result = runCli(
        ['use', 'vercel-labs/agent-skills@nextjs', '--skill', 'react-best-practices'],
        testDir
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Conflicting skill selectors');
    });

    it('uses --full-depth to discover nested skills skipped by normal discovery', () => {
      writeSkill(testDir, 'root-skill', 'Root.');
      writeSkill(join(testDir, 'nested', 'target'), 'target', 'Nested target.');

      const shallow = runCli(['use', testDir, '--skill', 'target'], testDir);
      const fullDepth = runCli(['use', testDir, '--skill', 'target', '--full-depth'], testDir);

      expect(shallow.exitCode).toBe(1);
      expect(shallow.stderr).toContain('No matching skill found');
      expect(fullDepth.exitCode).toBe(0);
      expect(fullDepth.stdout).toContain('Nested target.');
    });

    it('does not register prompt as a command alias', () => {
      const result = runCli(['prompt'], testDir);

      expect(result.stdout).toContain('Unknown command: prompt');
    });

    it('blocks OpenClaw sources before network access unless explicitly accepted', () => {
      const result = runCli(['use', 'openclaw/example@demo'], testDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('OpenClaw skills are unverified');
    });
  });
});

function writeSkill(skillDir: string, name: string, body: string): string {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: ${name}
description: ${name} description
---

# ${name}

${body}
`
  );
  return skillDir;
}

function extractSupportDir(stdout: string): string | undefined {
  const marker = 'Supporting files for this skill were downloaded to:\n';
  return stdout.split(marker)[1]?.split('\n')[0];
}
