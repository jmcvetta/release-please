// Copyright 2024 Google LLC
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

import {describe, it, afterEach, beforeEach} from 'mocha';
import * as sinon from 'sinon';
import {GitHub} from '../../../src/github';
import {Manifest} from '../../../src/manifest';
import {Update} from '../../../src/update';
import {
  buildGitHubFileContent,
  mockReleases,
  mockCommits,
  safeSnapshot,
  stubFilesFromFixtures,
  assertHasUpdates,
} from '../../helpers';
import {Version} from '../../../src/version';
import {PackageJson} from '../../../src/updaters/node/package-json';
import {expect} from 'chai';
import {Changelog} from '../../../src/updaters/changelog';
import {WorkspaceRepository} from './workspace-repository';
import {FileNotFoundError} from '../../../src/errors';

const sandbox = sinon.createSandbox();
const fixturesPath = './test/fixtures/plugins/node-workspace';

export function buildMockPackageUpdate(
  path: string,
  fixtureName: string
): Update {
  const cachedFileContents = buildGitHubFileContent(fixturesPath, fixtureName);
  return {
    path,
    createIfMissing: false,
    cachedFileContents,
    updater: new PackageJson({
      version: Version.parse(
        JSON.parse(cachedFileContents.parsedContent).version
      ),
    }),
  };
}

describe('Plugin compatibility', () => {
  let github: GitHub;
  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'fake-owner',
      repo: 'fake-repo',
      defaultBranch: 'main',
    });
  });
  afterEach(() => {
    sandbox.restore();
  });
  // Each proposal must preserve the entire base manifest except its own entry.
  for (const labels of [
    undefined,
    ['release: waiting', 'release: validated'],
  ]) {
    it(`preserves candidate ownership with ${
      labels ? 'configured' : 'default'
    } labels`, async () => {
      const repository = new WorkspaceRepository(
        github,
        sandbox,
        'workspace:^',
        true,
        labels
      );
      try {
        repository.change('c', 'feat: add library feature');
        const manifest = await repository.manifest();
        const candidates = await manifest.buildPullRequests();
        const base = repository.json('.release-please-manifest.json');
        expect(candidates).lengthOf(3);
        for (const candidate of candidates) {
          const name = candidate.body.releaseData[0].component!;
          const version = name === 'c' ? '1.1.0' : '1.0.1';
          const changes = await github.buildChangeSet(
            candidate.updates,
            'main'
          );
          expect(candidate.labels).to.eql(repository.labels);
          expect(
            JSON.parse(changes.get('.release-please-manifest.json')!.content!)
          ).to.eql({...base, [`packages/${name}`]: version});
          for (const other of ['a', 'b', 'c', 'unrelated']) {
            const file = `packages/${other}/package.json`;
            const contents = changes.get(file)?.content;
            expect(
              contents
                ? JSON.parse(contents).version
                : repository.json(file).version
            ).to.eql(other === name ? version : '1.0.0');
            const lock = JSON.parse(changes.get('package-lock.json')!.content!);
            expect(lock.packages[`packages/${other}`].version).to.eql(
              other === name ? version : '1.0.0'
            );
          }
          if (name !== 'c')
            expect(candidate.body.toString()).to.include('c bumped to 1.1.0');
        }
      } finally {
        repository.dispose();
      }
    });
  }
  describe('separate-pull-requests and workspace plugin', () => {
    it('retains combined workspace releases', async function () {
      this.timeout(30000);
      const repository = new WorkspaceRepository(
        github,
        sandbox,
        'workspace:^',
        false
      );
      try {
        repository.change('c', 'feat: add library feature');
        await (await repository.manifest()).createPullRequests();
        expect(repository.pulls).lengthOf(1);
        repository.merge(repository.pulls[0]);
        expect(
          (await (await repository.manifest()).createReleases())
            .map(release => release!.tagName)
            .sort()
        ).to.eql(['a-v1.0.1', 'b-v1.0.1', 'c-v1.1.0']);
        expect(repository.json('.release-please-manifest.json')).to.eql({
          'packages/a': '1.0.1',
          'packages/b': '1.0.1',
          'packages/c': '1.1.0',
          'packages/unrelated': '1.0.0',
          'packages/simple': '1.0.0',
        });
        expect(await (await repository.manifest()).createPullRequests()).to.eql(
          []
        );
      } finally {
        repository.dispose();
      }
    });
    // Notes outside versioned release sections must not suppress a needed update.
    it('ignores stale dependency notes outside release sections', async () => {
      const repository = new WorkspaceRepository(
        github,
        sandbox,
        'workspace:^',
        true,
        ['autorelease: pending'],
        '1.0.0',
        '# Changelog\n\n* c bumped to 3.0.0\n'
      );
      try {
        repository.change('c', 'feat: add library feature');
        const candidates = await (
          await repository.manifest()
        ).buildPullRequests();
        expect(
          candidates
            .map(candidate => candidate.body.releaseData[0].component)
            .sort()
        ).to.eql(['a', 'b', 'c']);
      } finally {
        repository.dispose();
      }
    });
    // An old release outside a deliberate range must not create dependency-only releases forever.
    it('preserves concrete ranges for previously released dependencies', async () => {
      const repository = new WorkspaceRepository(
        github,
        sandbox,
        '^1.0.0',
        true,
        ['autorelease: pending'],
        '2.0.0'
      );
      try {
        expect(await (await repository.manifest()).createPullRequests()).to.eql(
          []
        );
      } finally {
        repository.dispose();
      }
    });
    // A later independent consumer release must retain earlier dependency acknowledgments.
    for (const range of ['workspace:^', 'file:../c-9.0.0', 'link:../c-9.0.0']) {
      it(`retains dependency history across independent releases and tag fallback with ${range}`, async function () {
        this.timeout(30000);
        const repository = new WorkspaceRepository(github, sandbox, range);
        try {
          repository.change('c', 'feat: add library feature');
          await (await repository.manifest()).createPullRequests();
          repository.merge(repository.open('a'));
          await (await repository.manifest()).createReleases();
          repository.change('a', 'fix: independent consumer change');
          await (await repository.manifest()).createPullRequests();
          expect(repository.open('a').title).to.include('1.0.2');
          repository.merge(repository.open('a'));
          await (await repository.manifest()).createReleases();
          const expectedPending = [
            'chore(main): release b 1.0.1',
            'chore(main): release c 1.1.0',
          ];
          await (await repository.manifest()).createPullRequests();
          expect(
            repository.pulls
              .filter(pr => !pr.sha)
              .map(pr => pr.title)
              .sort()
          ).to.eql(expectedPending);
          repository.releases.length = 0;
          await (await repository.manifest()).createPullRequests();
          expect(
            repository.pulls
              .filter(pr => !pr.sha)
              .map(pr => pr.title)
              .sort()
          ).to.eql(expectedPending);
          repository.merge(repository.open('c'));
          await (await repository.manifest()).createReleases();
          await (await repository.manifest()).createPullRequests();
          repository.merge(repository.open('b'));
          await (await repository.manifest()).createReleases();
          expect(
            await (await repository.manifest()).createPullRequests()
          ).to.eql([]);
        } finally {
          repository.dispose();
        }
      });
    }
    // A registry alias must not release consumers of an unrelated registry package.
    it('excludes registry aliases whose key matches a workspace package', async () => {
      const repository = new WorkspaceRepository(
        github,
        sandbox,
        'npm:other@^1.0.0'
      );
      try {
        repository.change('c', 'feat: add library feature');
        await (await repository.manifest()).createPullRequests();
        expect(repository.pulls.map(pr => pr.title)).to.eql([
          'chore(main): release c 1.1.0',
        ]);
      } finally {
        repository.dispose();
      }
    });
    // A library release must not strand pending consumers or release one twice.
    for (const range of [
      'workspace:^',
      'workspace:*',
      'workspace:~',
      'workspace:^1.0.0',
      'file:../c',
      'link:../c',
      'file:../c-9.0.0',
      'link:../c-9.0.0',
      '^1.0.0',
      '~1.0.0',
      '1.0.0',
    ]) {
      for (const order of [
        ['c', 'a', 'b'],
        ['a', 'c', 'b'],
      ]) {
        it(`completes the ${order.join(
          '-'
        )} lifecycle with ${range} without generated state repairs`, async function () {
          this.timeout(30000);
          const repository = new WorkspaceRepository(github, sandbox, range);
          try {
            repository.change('c', 'feat: add library feature');
            await (await repository.manifest()).createPullRequests();
            const expectedVersions: Record<string, string> = {
              'packages/a': '1.0.0',
              'packages/b': '1.0.0',
              'packages/c': '1.0.0',
              'packages/unrelated': '1.0.0',
              'packages/simple': '1.0.0',
            };
            expect(repository.pulls.map(pr => pr.labels)).to.eql([
              repository.labels,
              repository.labels,
              repository.labels,
            ]);
            for (const name of order) {
              const pr = repository.open(name);
              const version = name === 'c' ? '1.1.0' : '1.0.1';
              expect(
                repository.json(
                  '.release-please-manifest.json',
                  pr.headBranchName
                )
              ).to.eql({...expectedVersions, [`packages/${name}`]: version});
              if (name !== 'c') {
                expect(pr.body).to.include('c bumped');
                expect(pr.body).to.include('1.1.0');
              }
              if (/^(file|link):/.test(range)) {
                for (const consumer of ['a', 'b']) {
                  expect(
                    repository.json(
                      `packages/${consumer}/package.json`,
                      pr.headBranchName
                    ).dependencies.c
                  ).to.equal(range);
                  expect(
                    repository.json('package-lock.json', pr.headBranchName)
                      .packages[`packages/${consumer}`].dependencies.c
                  ).to.equal(range);
                }
              }
              repository.merge(pr);
              expectedVersions[`packages/${name}`] = version;
              expect(repository.json('.release-please-manifest.json')).to.eql(
                expectedVersions
              );
              const releases = await (
                await repository.manifest()
              ).createReleases();
              expect(releases.map(release => release!.tagName)).to.eql([
                `${name}-v${version}`,
              ]);
              expect(pr.labels).to.eql(['autorelease: tagged']);
              repository.refreshes.length = 0;
              await (await repository.manifest()).createPullRequests();
              for (const pending of repository.pulls.filter(
                item => !item.sha
              )) {
                expect(repository.refreshes).to.include(pending.number);
              }
              expect(repository.pulls).lengthOf(3);
            }
            for (let run = 0; run < 2; run++) {
              expect(
                await (await repository.manifest()).createPullRequests()
              ).to.eql([]);
              expect(
                await (await repository.manifest()).createReleases()
              ).to.eql([]);
            }
            expect(repository.pulls.filter(pr => !pr.sha)).to.eql([]);
            repository.change('a', 'fix: independent consumer change');
            repository.change('unrelated', 'fix: independent node change');
            repository.change('simple', 'fix: independent simple change');
            await (await repository.manifest()).createPullRequests();
            expect(repository.open('a').title).to.include('1.0.2');
            expect(repository.open('unrelated').title).to.include('1.0.1');
            expect(repository.open('simple').title).to.include('1.0.1');
          } finally {
            repository.dispose();
          }
        });
      }
    }
    it('should version bump dependencies together', async () => {
      // Scenario:
      //   - package a,b depends on c
      //   - package c receives a new feature
      //   - package a,b version bumps its dependency on c
      //   - package a and b should both use a minor version bump
      //   - each package should have its own PR
      mockReleases(sandbox, github, [
        {
          id: 123456,
          sha: 'abc123',
          tagName: 'pkgA-v1.0.0',
          url: 'https://github.com/fake-owner/fake-repo/releases/tag/pkgA-v1.0.0',
        },
        {
          id: 654321,
          sha: 'abc123',
          tagName: 'pkgB-v1.0.0',
          url: 'https://github.com/fake-owner/fake-repo/releases/tag/pkgB-v1.0.0',
        },
        {
          id: 987654,
          sha: 'abc123',
          tagName: 'pkgC-v1.0.0',
          url: 'https://github.com/fake-owner/fake-repo/releases/tag/pkgC-v1.0.0',
        },
      ]);
      mockCommits(sandbox, github, [
        {
          sha: 'aaaaaa',
          message: 'feat: some feature',
          files: ['packages/node3/foo'],
        },
      ]);
      stubFilesFromFixtures({
        sandbox,
        github,
        fixturePath: fixturesPath,
        files: [],
        flatten: false,
        targetBranch: 'main',
        inlineFiles: [
          [
            'package.json',
            '{ "name": "root", "version": "2.0.0", "workspaces": ["packages/*"] }',
          ],
          [
            'packages/node1/package.json',
            '{ "name": "pkgA", "version": "1.0.0", "dependencies": { "pkgC": "workspace:*" } }',
          ],
          [
            'packages/node2/package.json',
            '{ "name": "pkgB", "version": "1.0.0", "dependencies": { "pkgC": "workspace:*" } }',
          ],
          [
            'packages/node3/package.json',
            '{ "name": "pkgC", "version": "1.0.0" }',
          ],
        ],
      });
      (github.getFileContentsOnBranch as sinon.SinonStub).rejects(
        new FileNotFoundError('missing')
      );
      sandbox
        .stub(github, 'findFilesByGlobAndRef')
        .withArgs('packages/node1', 'main')
        .resolves(['packages/node1'])
        .withArgs('packages/node2', 'main')
        .resolves(['packages/node2'])
        .withArgs('packages/node3', 'main')
        .resolves(['packages/node3']);
      const manifest = new Manifest(
        github,
        'main',
        {
          'packages/node1': {
            releaseType: 'node',
            component: 'pkgA',
          },
          'packages/node2': {
            releaseType: 'node',
            component: 'pkgB',
          },
          'packages/node3': {
            releaseType: 'node',
            component: 'pkgC',
          },
        },
        {
          'packages/node1': Version.parse('1.0.0'),
          'packages/node2': Version.parse('1.0.0'),
          'packages/node3': Version.parse('1.0.0'),
        },
        {
          plugins: [{type: 'node-workspace'}],
          separatePullRequests: true,
        }
      );
      const pullRequests = await manifest.buildPullRequests();
      expect(pullRequests).lengthOf(3);

      const pullRequest1 = pullRequests[0];
      safeSnapshot(pullRequest1.body.toString());
      const updaterA = (
        assertHasUpdates(
          pullRequest1.updates,
          'packages/node1/CHANGELOG.md',
          Changelog
        ) as Update
      ).updater as Changelog;
      expect(updaterA.version.toString()).to.eql('1.0.1');

      const pullRequest2 = pullRequests[1];
      safeSnapshot(pullRequest2.body.toString());
      const updaterB = (
        assertHasUpdates(
          pullRequest2.updates,
          'packages/node2/CHANGELOG.md',
          Changelog
        ) as Update
      ).updater as Changelog;
      expect(updaterB.version.toString()).to.eql('1.0.1');

      const pullRequest3 = pullRequests[2];
      safeSnapshot(pullRequest3.body.toString());
      const updaterC = (
        assertHasUpdates(
          pullRequest3.updates,
          'packages/node3/CHANGELOG.md',
          Changelog
        ) as Update
      ).updater as Changelog;
      expect(updaterC.version.toString()).to.eql('1.1.0');
    });
  });
});
