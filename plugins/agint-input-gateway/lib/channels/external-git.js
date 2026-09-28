/**
 * C3 外部世界 Channel — git 子源（P1）。
 *
 * 检测本地 git 仓库的 HEAD 变化：用户更新上游快照后，对比上次记录产出信号。
 * 不做网络 fetch——dsh/openclaw 是 tarball 快照无 remote，Hermes 走代理不稳定。
 *
 * 信号内容：哪个仓库有新 commit、新旧 HEAD、新 commit 数量、最新 commit 摘要。
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CHANNEL_TYPES, C3_GIT_REPOS } from '../schema.js';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function stateFile() {
  return join(dshHome(), 'storages', 'agint_input_gateway_git_state.json');
}

function loadState() {
  try {
    if (!existsSync(stateFile())) return {};
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    const dir = join(dshHome(), 'storages');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch { /* 软降级 */ }
}

/** 在指定目录执行 git 命令，失败返回 null */
function git(repoPath, args) {
  try {
    return execSync(`git ${args}`, {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** 获取仓库当前 HEAD 信息 */
function getHead(repoPath) {
  const hash = git(repoPath, 'rev-parse HEAD');
  if (!hash) return null;
  const date = git(repoPath, 'log -1 --format=%cI');
  const message = git(repoPath, 'log -1 --format=%s');
  return { hash, date, message };
}

/** 计算两个 commit 之间的新 commit 数量 */
function countNewCommits(repoPath, oldHash, newHash) {
  if (!oldHash || !newHash || oldHash === newHash) return 0;
  const count = git(repoPath, `rev-list --count ${oldHash}..${newHash}`);
  return parseInt(count, 10) || 0;
}

export const externalGitChannel = {
  id: 'external-git',
  type: CHANNEL_TYPES.EXTERNAL,
  cron: '0 4 * * 0',

  async fetch(_ctx) {
    const prevState = loadState();
    const newState = {};
    const signals = [];

    for (const repo of C3_GIT_REPOS) {
      const head = getHead(repo.path);
      if (!head) {
        // 仓库不可读，记录上次已知状态
        if (prevState[repo.id]) newState[repo.id] = prevState[repo.id];
        continue;
      }

      newState[repo.id] = head;
      const prev = prevState[repo.id];

      if (!prev) {
        // 首次记录，不产出信号（基线）
        continue;
      }

      if (prev.hash === head.hash) {
        // 无变化
        continue;
      }

      // HEAD 变了——有新 commit
      const newCount = countNewCommits(repo.path, prev.hash, head.hash);
      signals.push({
        signalId: `repo-diff-${repo.id}-${head.hash.slice(0, 8)}`,
        source: `git:${repo.id}`,
        signalType: 'repo.diff',
        payload: {
          repoId: repo.id,
          repoLabel: repo.label,
          oldHead: prev.hash.slice(0, 8),
          newHead: head.hash.slice(0, 8),
          newCommitCount: newCount,
          latestCommit: head.message,
          latestDate: head.date,
        },
        confidence: 0.9,
        relevance: 0.7,
        occurredAt: new Date().toISOString(),
        rawRef: repo.path,
      });
    }

    saveState(newState);
    return signals;
  },

  async health() {
    const state = loadState();
    const tracked = C3_GIT_REPOS.map((r) => ({
      repo: r.id,
      knownHead: state[r.id]?.hash?.slice(0, 8) || 'unknown',
    }));
    return {
      channelId: this.id,
      status: 'ok',
      repos: tracked,
      note: 'P1: 检测本地 HEAD 变化，不做网络 fetch；首次记录为基线不产信号',
    };
  },
};
