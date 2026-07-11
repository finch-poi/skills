import * as p from '@clack/prompts';
import pc from 'picocolors';
import { resolve, join, dirname } from 'path';
import { readLocalLock } from './local-lock.ts';
import { runAdd } from './add.ts';
import { runSync, parseSyncOptions } from './sync.ts';
import { getUniversalAgents, agents } from './agents.ts';
import type { AgentType } from './types.ts';
import { linkLocalSkill } from './installer.ts';
import { buildLocalUpdateSource } from './update-source.ts';
import { syncContextLinks } from './context-links.ts';

/**
 * Resolve the target agent list for `experimental_install` and `update`.
 *
 * If the lock file has a top-level `agents` array, those agent names are
 * validated and used. Invalid names are warned about and dropped.
 * When the `agents` field is absent or empty, the function falls back to
 * the default universal agents (`.agents/skills/`).
 */
export function resolveInstallAgents(lockAgents: string[] | undefined): AgentType[] {
  const validAgentNames = Object.keys(agents);

  if (lockAgents && lockAgents.length > 0) {
    const valid = lockAgents.filter((a) => validAgentNames.includes(a));
    const invalid = lockAgents.filter((a) => !validAgentNames.includes(a));

    if (invalid.length > 0) {
      p.log.warn(
        `Unknown agents in skills-lock.json: ${invalid.join(', ')} — skipping. Valid: ${validAgentNames.join(', ')}`
      );
    }

    if (valid.length > 0) {
      return valid as AgentType[];
    }
  }

  return getUniversalAgents();
}

/**
 * Install all skills from the local skills-lock.json.
 * Groups skills by source and calls `runAdd` for each group.
 *
 * When the lock file contains a top-level `agents` array, skills are
 * installed to those agent directories. Otherwise, skills are installed
 * only to `.agents/skills/` (universal agents) — the canonical
 * project-level location.
 *
 * node_modules skills are handled via experimental_sync.
 */
export async function runInstallFromLock(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const lock = await readLocalLock(cwd);
  const skillEntries = Object.entries(lock.skills);

  if (skillEntries.length === 0) {
    p.log.warn('No project skills found in skills-lock.json');
    p.log.info(
      `Add project-level skills with ${pc.cyan('npx skills add <package>')} (without ${pc.cyan('-g')})`
    );
    return;
  }

  // Determine target agents: use lock-file `agents` config, or fall back to universal
  const targetAgentNames = resolveInstallAgents(lock.agents);

  // Separate skills by installation strategy
  const nodeModuleSkills: string[] = [];
  const localLinkedSkills: Array<{ name: string; source: string; skillPath?: string }> = [];
  const bySource = new Map<string, { sourceType: string; skills: string[] }>();

  for (const [skillName, entry] of skillEntries) {
    if (entry.sourceType === 'node_modules') {
      nodeModuleSkills.push(skillName);
      continue;
    }

    // Direct-symlink local skills: skip runAdd, link directly
    if (entry.link && entry.sourceType === 'local') {
      localLinkedSkills.push({ name: skillName, source: entry.source, skillPath: entry.skillPath });
      continue;
    }

    const installSource = buildLocalUpdateSource(entry);
    if (!installSource) {
      p.log.error(
        `Cannot restore ${pc.cyan(skillName)}: skills-lock.json is missing sourceUrl for this generic Git source`
      );
      continue;
    }
    const existing = bySource.get(installSource);
    if (existing) {
      existing.skills.push(skillName);
    } else {
      bySource.set(installSource, {
        sourceType: entry.sourceType,
        skills: [skillName],
      });
    }
  }

  const remoteCount = skillEntries.length - nodeModuleSkills.length - localLinkedSkills.length;
  if (localLinkedSkills.length > 0) {
    const agentDirs = targetAgentNames.map((a) => agents[a].skillsDir);
    const uniqueDirs = [...new Set(agentDirs)];
    p.log.info(
      `Linking ${pc.cyan(String(localLinkedSkills.length))} local skill${localLinkedSkills.length !== 1 ? 's' : ''} into ${pc.dim(uniqueDirs.join(', '))}`
    );
  }
  if (remoteCount > 0) {
    const agentDirs = targetAgentNames.map((a) => agents[a].skillsDir);
    const uniqueDirs = [...new Set(agentDirs)];
    p.log.info(
      `Restoring ${pc.cyan(String(remoteCount))} skill${remoteCount !== 1 ? 's' : ''} from skills-lock.json into ${pc.dim(uniqueDirs.join(', '))}`
    );
  }

  // Link local skills (direct symlinks — no copy)
  for (const { name, source, skillPath } of localLinkedSkills) {
    // Resolve skill directory from source root + skillPath
    const sourceRoot = resolve(cwd, source);
    const skillDir = skillPath ? join(sourceRoot, dirname(skillPath)) : sourceRoot;
    for (const agentType of targetAgentNames) {
      const result = await linkLocalSkill(skillDir, name, agentType, { cwd });
      if (!result.success && !result.skipped) {
        p.log.error(`Failed to link ${pc.cyan(name)}: ${result.error ?? 'Unknown error'}`);
      }
    }
  }

  // Install remote skills grouped by source
  for (const [source, { skills }] of bySource) {
    try {
      await runAdd([source], {
        skill: skills,
        agent: targetAgentNames,
        yes: true,
      });
    } catch (error) {
      p.log.error(
        `Failed to install from ${pc.cyan(source)}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Handle node_modules skills via sync
  if (nodeModuleSkills.length > 0) {
    p.log.info(
      `${pc.cyan(String(nodeModuleSkills.length))} skill${nodeModuleSkills.length !== 1 ? 's' : ''} from node_modules`
    );
    try {
      const { options: syncOptions } = parseSyncOptions(args);
      await runSync(args, { ...syncOptions, yes: true, agent: targetAgentNames });
    } catch (error) {
      p.log.error(
        `Failed to sync node_modules skills: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Restore context file links (e.g., AGENTS.md -> CLAUDE.md symlinks)
  if (lock.contextFile) {
    try {
      const results = await syncContextLinks(lock.contextFile, targetAgentNames, cwd);
      for (const r of results) {
        if (r.created) {
          const loc = r.dir === '.' ? r.target : `${r.dir}/${r.target}`;
          p.log.info(`Linked ${pc.cyan(loc)} → ${pc.dim(r.source)}`);
        } else if (r.warning) {
          p.log.warn(r.warning);
        }
      }
    } catch {
      // Don't fail install if context link sync fails
    }
  }
}
