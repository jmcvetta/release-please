// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {execFileSync} from 'child_process';
import {mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';
import * as sinon from 'sinon';
import {GitHub, GitHubRelease} from '../../../src/github';
import {Manifest} from '../../../src/manifest';
import {PullRequest} from '../../../src/pull-request';
import {Update} from '../../../src/update';
import {FileNotFoundError} from '../../../src/errors';
import {buildGitHubFileRaw} from '../../helpers';

type FixturePullRequest = {-readonly [K in keyof PullRequest]: PullRequest[K]};

/** WorkspaceRepository models only SCM, retaining real Git branches and squash merges. */
export class WorkspaceRepository {
  readonly directory = mkdtempSync(join(tmpdir(), 'release-please-workspace-'));
  readonly pulls: FixturePullRequest[] = [];
  readonly releases: GitHubRelease[] = [];
  readonly refreshes: number[] = [];
  private merged = new Map<string, PullRequest>();
  private nextNumber = 1;

  constructor(
    readonly github: GitHub,
    sandbox: sinon.SinonSandbox,
    range = 'workspace:^',
    separate = true,
    readonly labels = ['autorelease: pending']
  ) {
    this.git('init', '--initial-branch=main');
    this.git('config', 'user.name', 'Release fixture');
    this.git('config', 'user.email', 'fixture@example.com');
    this.write(
      'package.json',
      JSON.stringify({private: true, workspaces: ['packages/*']})
    );
    const packages: Record<string, object> = {};
    const versions: Record<string, string> = {};
    for (const name of ['a', 'b', 'c', 'unrelated', 'simple']) {
      const path = `packages/${name}`;
      packages[path] = {
        component: name,
        'release-type': name === 'simple' ? 'simple' : 'node',
      };
      versions[path] = '1.0.0';
      this.write(`${path}/CHANGELOG.md`, '# Changelog\n');
      this.write(
        `${path}/package.json`,
        JSON.stringify({
          name,
          version: '1.0.0',
          ...(['a', 'b'].includes(name) ? {dependencies: {c: range}} : {}),
        })
      );
      if (name === 'simple') this.write(`${path}/version.txt`, '1.0.0\n');
    }
    const lockPackages: Record<string, object> = {
      '': {name: 'root', version: '1.0.0'},
    };
    for (const name of ['a', 'b', 'c', 'unrelated']) {
      lockPackages[`packages/${name}`] = {
        name,
        version: '1.0.0',
        ...(['a', 'b'].includes(name) ? {dependencies: {c: range}} : {}),
      };
      lockPackages[`node_modules/${name}`] = {
        resolved: `packages/${name}`,
        link: true,
      };
    }
    this.write(
      'package-lock.json',
      JSON.stringify(
        {
          name: 'root',
          version: '1.0.0',
          lockfileVersion: 3,
          packages: lockPackages,
        },
        null,
        2
      ) + '\n'
    );
    this.write(
      '.release-please-manifest.json',
      JSON.stringify(versions, null, 2) + '\n'
    );
    this.write(
      'release-please-config.json',
      JSON.stringify({
        'always-update': true,
        'separate-pull-requests': separate,
        'include-component-in-tag': true,
        label: labels.join(','),
        plugins: [{type: 'node-workspace', merge: !separate}],
        packages,
      })
    );
    this.commit('chore: initial versions');
    for (const name of ['a', 'b', 'c', 'unrelated', 'simple']) {
      const tagName = `${name}-v1.0.0`;
      this.git('tag', tagName);
      this.releases.push({
        id: this.releases.length + 1,
        tagName,
        sha: this.git('rev-parse', 'HEAD'),
        url: `https://example.com/${tagName}`,
        notes: '',
      });
    }
    sandbox
      .stub(github, 'getFileContentsOnBranch')
      .callsFake(async (path, ref) => {
        try {
          return buildGitHubFileRaw(this.git('show', `${ref}:${path}`));
        } catch {
          throw new FileNotFoundError(path);
        }
      });
    sandbox
      .stub(github, 'getFileJson')
      .callsFake(async (path, ref) => this.json(path, ref));
    sandbox
      .stub(github, 'findFilesByGlobAndRef')
      .callsFake(async (glob, ref) => {
        const files = this.git('ls-tree', '-r', '--name-only', ref).split('\n');
        return files.some(file => file.startsWith(`${glob}/`)) ? [glob] : [];
      });
    sandbox.stub(github, 'mergeCommitIterator').callsFake(
      async function* (this: WorkspaceRepository) {
        for (const sha of this.git('rev-list', 'main').split('\n')) {
          yield {
            sha,
            message: this.git('show', '-s', '--format=%B', sha),
            files: this.git(
              'diff-tree',
              '--root',
              '--no-commit-id',
              '--name-only',
              '-r',
              sha
            )
              .split('\n')
              .filter(Boolean),
            pullRequest: this.merged.get(sha),
          };
        }
      }.bind(this)
    );
    sandbox.stub(github, 'releaseIterator').callsFake(
      async function* (this: WorkspaceRepository) {
        yield* [...this.releases].reverse();
      }.bind(this)
    );
    sandbox.stub(github, 'tagIterator').callsFake(
      async function* (this: WorkspaceRepository) {
        for (const name of this.git('tag').split('\n').filter(Boolean)) {
          yield {name, sha: this.git('rev-list', '-n', '1', name)};
        }
      }.bind(this)
    );
    sandbox.stub(github, 'pullRequestIterator').callsFake(
      async function* (
        this: WorkspaceRepository,
        ...[_branch, status]: Parameters<GitHub['pullRequestIterator']>
      ) {
        yield* this.pulls.filter(pr =>
          status === 'MERGED' ? !!pr.sha : status === 'CLOSED' ? false : !pr.sha
        );
      }.bind(this)
    );
    sandbox
      .stub(github, 'createPullRequest')
      .callsFake(async (pr, _branch, _message, updates) => {
        const result = {...pr, number: this.nextNumber++};
        result.files = await this.updateBranch(result.headBranchName, updates);
        this.pulls.push(result);
        return result;
      });
    sandbox.stub(github, 'updatePullRequest').callsFake(async (number, pr) => {
      const existing = this.pulls.find(item => item.number === number)!;
      existing.files = await this.updateBranch(pr.headRefName, pr.updates);
      existing.title = pr.title.toString();
      existing.body = pr.body.toString();
      this.refreshes.push(number);
      return existing;
    });
    sandbox.stub(github, 'createRelease').callsFake(async release => {
      const tagName = release.tag.toString();
      this.git('tag', tagName, release.sha);
      const result = {
        id: this.releases.length + 1,
        tagName,
        sha: release.sha,
        notes: release.notes,
        url: `https://example.com/${tagName}`,
      };
      this.releases.push(result);
      return result;
    });
    sandbox
      .stub(github, 'commentOnIssue')
      .resolves('https://example.com/comment');
    sandbox
      .stub(github, 'removeIssueLabels')
      .callsFake(async (labels, number) => {
        const pr = this.pulls.find(item => item.number === number)!;
        pr.labels = pr.labels.filter(label => !labels.includes(label));
      });
    sandbox.stub(github, 'addIssueLabels').callsFake(async (labels, number) => {
      this.pulls.find(item => item.number === number)!.labels.push(...labels);
    });
  }

  git(...args: string[]): string {
    const output = execFileSync('git', args, {
      cwd: this.directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(this.directory, '.git', 'fixture-global-config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
      },
    });
    return args[0] === 'show' && args.length === 2 ? output : output.trimEnd();
  }

  write(path: string, content: string) {
    const file = join(this.directory, path);
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, content);
  }

  json(path: string, ref = 'main') {
    return JSON.parse(this.git('show', `${ref}:${path}`));
  }

  commit(message: string) {
    this.git('add', '.');
    this.git('commit', '--quiet', '-m', message);
  }

  change(name: string, message: string) {
    this.write(`packages/${name}/source.txt`, message + '\n');
    this.commit(message);
  }

  manifest() {
    return Manifest.fromManifest(this.github, 'main');
  }

  open(name: string): FixturePullRequest {
    const pr = this.pulls.find(
      pr => !pr.sha && pr.headBranchName.endsWith(`--components--${name}`)
    );
    if (!pr) throw new Error(`No open release for ${name}`);
    return pr;
  }

  merge(pr: FixturePullRequest) {
    this.git('merge', '--squash', pr.headBranchName);
    this.git('commit', '--quiet', '-m', `${pr.title} (#${pr.number})`);
    pr.sha = this.git('rev-parse', 'HEAD');
    this.merged.set(pr.sha, {...pr});
  }

  dispose() {
    rmSync(this.directory, {recursive: true, force: true});
  }

  private async updateBranch(
    branch: string,
    updates: Update[]
  ): Promise<string[]> {
    const changes = await this.github.buildChangeSet(updates, 'main');
    this.git('checkout', '-B', branch, 'main');
    for (const [path, change] of changes) {
      if (change.content !== null) this.write(path, change.content);
    }
    this.git('add', '.');
    if (this.git('diff', '--cached', '--name-only'))
      this.git('commit', '--quiet', '-m', 'chore: release proposal');
    const files = this.git('diff', '--name-only', 'main...HEAD')
      .split('\n')
      .filter(Boolean);
    this.git('checkout', 'main');
    return files;
  }
}
