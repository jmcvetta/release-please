// Copyright 2021 Google LLC
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

import {Scm} from '../scm';
import {CandidateReleasePullRequest, RepositoryConfig} from '../manifest';
import {PackageLockJson} from '../updaters/node/package-lock-json';
import {Version, VersionsMap} from '../version';
import {PullRequestTitle} from '../util/pull-request-title';
import {PullRequestBody} from '../util/pull-request-body';
import {ReleasePullRequest} from '../release-pull-request';
import {BranchName} from '../util/branch-name';
import {Changelog} from '../updaters/changelog';
import {
  WorkspacePlugin,
  DependencyGraph,
  DependencyNode,
  WorkspacePluginOptions,
  appendDependenciesSectionToChangelog,
  addPath,
} from './workspace';
import {Strategy} from '../strategy';
import {Commit} from '../commit';
import {Release} from '../release';
import {CompositeUpdater} from '../updaters/composite';
import {
  PackageJson,
  newVersionWithRange,
  NPM_PROTOCOL_REGEXP,
} from '../updaters/node/package-json';
import {Logger} from '../util/logger';
import {PatchVersionUpdate} from '../versioning-strategy';
import * as semver from 'semver';
import {FileNotFoundError} from '../errors';

interface ParsedPackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface Package {
  path: string;
  name: string;
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  jsonContent: string;
}

interface NodeWorkspaceOptions extends WorkspacePluginOptions {
  alwaysLinkLocal?: boolean;
  updatePeerDependencies?: boolean;
}

/**
 * The plugin analyzed a cargo workspace and will bump dependencies
 * of managed packages if those dependencies are being updated.
 *
 * If multiple node packages are being updated, it will merge them
 * into a single node package.
 */
export class NodeWorkspace extends WorkspacePlugin<Package> {
  private alwaysLinkLocal: boolean;

  private strategiesByPath: Record<string, Strategy> = {};
  private releasesByPath: Record<string, Release> = {};
  private candidatesByPackage: Record<string, CandidateReleasePullRequest> = {};
  private acknowledgedVersions = new Map<string, VersionsMap>();
  private dependencyVersions: VersionsMap = new Map();
  private packagesByPath = new Map<string, Package>();

  readonly updatePeerDependencies: boolean;
  constructor(
    github: Scm,
    targetBranch: string,
    repositoryConfig: RepositoryConfig,
    options: NodeWorkspaceOptions = {}
  ) {
    super(github, targetBranch, repositoryConfig, options);

    this.alwaysLinkLocal = options.alwaysLinkLocal === false ? false : true;
    this.updatePeerDependencies = options.updatePeerDependencies === true;
    this.runWithoutCandidates = !this.merge;
  }
  protected async buildAllPackages(
    candidates: CandidateReleasePullRequest[]
  ): Promise<{
    allPackages: Package[];
    candidatesByPackage: Record<string, CandidateReleasePullRequest>;
  }> {
    const candidatesByPath = new Map<string, CandidateReleasePullRequest>();
    for (const candidate of candidates) {
      candidatesByPath.set(candidate.path, candidate);
    }
    const candidatesByPackage: Record<string, CandidateReleasePullRequest> = {};

    const packagesByPath = new Map<string, Package>();
    for (const path in this.repositoryConfig) {
      const config = this.repositoryConfig[path];
      if (config.releaseType !== 'node') {
        continue;
      }
      const candidate = candidatesByPath.get(path);
      if (candidate) {
        this.logger.debug(
          `Found candidate pull request for path: ${candidate.path}`
        );
        const packagePath = addPath(candidate.path, 'package.json');
        const packageUpdate = candidate.pullRequest.updates.find(
          update => update.path === packagePath
        );
        const contents =
          packageUpdate?.cachedFileContents ??
          (await this.github.getFileContentsOnBranch(
            packagePath,
            this.targetBranch
          ));
        const packageJson: ParsedPackageJson = JSON.parse(
          contents.parsedContent
        );
        const pkg: Package = {
          name: packageJson.name,
          path,
          version: packageJson.version,
          dependencies: packageJson.dependencies || {},
          devDependencies: packageJson.devDependencies || {},
          peerDependencies: packageJson.peerDependencies || {},
          optionalDependencies: packageJson.optionalDependencies || {},
          jsonContent: contents.parsedContent,
        };
        packagesByPath.set(candidate.path, pkg);
        candidatesByPackage[pkg.name] = candidate;
        // }
      } else {
        const packagePath = addPath(path, 'package.json');
        this.logger.debug(
          `No candidate pull request for path: ${path} - inspect package from ${packagePath}`
        );
        const contents = await this.github.getFileContentsOnBranch(
          packagePath,
          this.targetBranch
        );
        const packageJson: ParsedPackageJson = JSON.parse(
          contents.parsedContent
        );
        const pkg: Package = {
          name: packageJson.name,
          path,
          version: packageJson.version,
          dependencies: packageJson.dependencies || {},
          devDependencies: packageJson.devDependencies || {},
          peerDependencies: packageJson.peerDependencies || {},
          optionalDependencies: packageJson.optionalDependencies || {},
          jsonContent: contents.parsedContent,
        };
        packagesByPath.set(path, pkg);
      }
    }
    const allPackages = Array.from(packagesByPath.values());
    this.candidatesByPackage = candidatesByPackage;
    this.packagesByPath = packagesByPath;
    return {
      allPackages,
      candidatesByPackage,
    };
  }

  protected bumpVersion(pkg: Package): Version {
    const version = Version.parse(pkg.version);
    const strategy = this.strategiesByPath[pkg.path];

    if (strategy) return strategy.versioningStrategy.bump(version, []);
    return new PatchVersionUpdate().bump(version);
  }

  protected updateCandidate(
    existingCandidate: CandidateReleasePullRequest,
    pkg: Package,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    updatedVersions = this.versionsForPackage(pkg, updatedVersions);
    // Update version of the package
    const newVersion = updatedVersions.get(pkg.name);
    if (!newVersion) {
      throw new Error(`Didn't find updated version for ${pkg.name}`);
    }
    const updatedPackage = {
      ...pkg,
      version: newVersion.toString(),
    };

    const updater = new PackageJson({
      version: newVersion,
      versionsMap: updatedVersions,
      updatePeerDependencies: this.updatePeerDependencies,
    });
    const dependencyNotes = getChangelogDepsNotes(
      pkg,
      updatedPackage,
      updatedVersions,
      this.logger
    );

    existingCandidate.pullRequest.updates =
      existingCandidate.pullRequest.updates.map(update => {
        if (update.path === addPath(existingCandidate.path, 'package.json')) {
          update.updater = new CompositeUpdater(update.updater, updater);
        } else if (
          update.path === addPath(existingCandidate.path, 'package-lock.json')
        ) {
          update.updater = new PackageLockJson({
            version: newVersion,
            versionsMap: updatedVersions,
          });
        } else if (update.updater instanceof Changelog) {
          if (dependencyNotes) {
            update.updater.changelogEntry =
              appendDependenciesSectionToChangelog(
                update.updater.changelogEntry,
                dependencyNotes,
                this.logger
              );
          }
        }
        return update;
      });

    // append dependency notes
    if (dependencyNotes) {
      if (existingCandidate.pullRequest.body.releaseData.length > 0) {
        existingCandidate.pullRequest.body.releaseData[0].notes =
          appendDependenciesSectionToChangelog(
            existingCandidate.pullRequest.body.releaseData[0].notes,
            dependencyNotes,
            this.logger
          );
      } else {
        existingCandidate.pullRequest.body.releaseData.push({
          component: updatedPackage.name,
          version: existingCandidate.pullRequest.version,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        });
      }
    }
    return existingCandidate;
  }
  protected async newCandidate(
    pkg: Package,
    updatedVersions: VersionsMap
  ): Promise<CandidateReleasePullRequest> {
    updatedVersions = this.versionsForPackage(pkg, updatedVersions);
    // Update version of the package
    const newVersion = updatedVersions.get(pkg.name);
    if (!newVersion) {
      throw new Error(`Didn't find updated version for ${pkg.name}`);
    }
    const updatedPackage = {
      ...pkg,
      version: newVersion.toString(),
    };

    const dependencyNotes = getChangelogDepsNotes(
      pkg,
      updatedPackage,
      updatedVersions,
      this.logger
    );

    const strategy = this.strategiesByPath[updatedPackage.path];
    const latestRelease = this.releasesByPath[updatedPackage.path];

    const basePullRequest = strategy
      ? await strategy.buildReleasePullRequest([], latestRelease, false, [], {
          newVersion,
        })
      : undefined;

    if (basePullRequest) {
      return this.updateCandidate(
        {
          path: pkg.path,
          pullRequest: basePullRequest,
          config: {
            releaseType: 'node',
          },
        },
        pkg,
        updatedVersions
      );
    }

    const pullRequest: ReleasePullRequest = {
      title: PullRequestTitle.ofTargetBranch(this.targetBranch),
      body: new PullRequestBody([
        {
          component: updatedPackage.name,
          version: newVersion,
          notes: appendDependenciesSectionToChangelog(
            '',
            dependencyNotes,
            this.logger
          ),
        },
      ]),
      updates: [
        {
          path: addPath(updatedPackage.path, 'package.json'),
          createIfMissing: false,
          updater: new PackageJson({
            version: newVersion,
            versionsMap: updatedVersions,
            updatePeerDependencies: this.updatePeerDependencies,
          }),
        },
        {
          path: addPath(updatedPackage.path, 'package-lock.json'),
          createIfMissing: false,
          updater: new PackageJson({
            version: newVersion,
            versionsMap: updatedVersions,
            updatePeerDependencies: this.updatePeerDependencies,
          }),
        },
        {
          path: addPath(updatedPackage.path, 'CHANGELOG.md'),
          createIfMissing: false,
          updater: new Changelog({
            version: newVersion,
            changelogEntry: appendDependenciesSectionToChangelog(
              '',
              dependencyNotes,
              this.logger
            ),
          }),
        },
      ],
      labels: [],
      headRefName: BranchName.ofTargetBranch(this.targetBranch).toString(),
      version: newVersion,
      draft: false,
    };
    return {
      path: updatedPackage.path,
      pullRequest,
      config: {
        releaseType: 'node',
      },
    };
  }

  protected postProcessCandidates(
    candidates: CandidateReleasePullRequest[],
    _updatedVersions: VersionsMap
  ): CandidateReleasePullRequest[] {
    if (candidates.length === 0) {
      return candidates;
    }
    if (!this.merge) {
      for (const candidate of candidates) {
        const pkg = this.packagesByPath.get(candidate.path)!;
        const updater = new PackageLockJson({
          version:
            pkg.path === '.' ? candidate.pullRequest.version : undefined,
          versionsMap: this.versionsForPackage(pkg, _updatedVersions),
          workspacePackage: pkg.name,
        });
        const existing = candidate.pullRequest.updates.find(
          update => update.path === 'package-lock.json'
        );
        if (existing) {
          existing.updater = updater;
        } else {
          candidate.pullRequest.updates.push({
            path: 'package-lock.json',
            createIfMissing: false,
            updater,
          });
        }
      }
      return candidates;
    }

    const [candidate] = candidates;

    // check for root lock file in pull request
    let hasRootLockFile: boolean | undefined;
    for (let i = 0; i < candidate.pullRequest.updates.length; i++) {
      if (
        candidate.pullRequest.updates[i].path === '.package-lock.json' ||
        candidate.pullRequest.updates[i].path === './package-lock.json' ||
        candidate.pullRequest.updates[i].path === 'package-lock.json' ||
        candidate.pullRequest.updates[i].path === '/package-lock.json'
      ) {
        hasRootLockFile = true;
        break;
      }
    }

    // if there is a root lock file, then there is no additional pull request update necessary.
    if (hasRootLockFile) {
      return candidates;
    }

    candidate.pullRequest.updates.push({
      path: 'package-lock.json',
      createIfMissing: false,
      updater: new PackageLockJson({
        versionsMap: _updatedVersions,
      }),
    });

    return candidates;
  }

  protected async buildGraph(
    allPackages: Package[]
  ): Promise<DependencyGraph<Package>> {
    const graph = new Map<string, DependencyNode<Package>>();
    const workspacePackageNames = new Set(
      allPackages.map(packageJson => packageJson.name)
    );
    for (const packageJson of allPackages) {
      const dependencies = this.combineDeps(packageJson);
      const workspaceDeps = Object.keys(dependencies).filter(
        dep =>
          workspacePackageNames.has(dep) &&
          (this.merge ||
            !NPM_PROTOCOL_REGEXP.test(dependencies[dep]) ||
            dependencies[dep].startsWith('workspace:'))
      );
      graph.set(packageJson.name, {
        deps: workspaceDeps,
        value: packageJson,
      });
    }

    this.acknowledgedVersions.clear();
    if (!this.merge) {
      for (const [name, {value: pkg, deps}] of graph) {
        const versions: VersionsMap = new Map();
        const noteVersions = this.dependencyNoteVersions(
          await this.acknowledgmentNotes(pkg)
        );
        for (const dep of deps) {
          versions.set(
            dep,
            await this.acknowledgedDependencyVersion(
              pkg,
              graph.get(dep)!.value,
              this.combineDeps(pkg)[dep],
              noteVersions.get(dep)
            )
          );
        }
        this.acknowledgedVersions.set(name, versions);
      }
    }
    return graph;
  }

  protected buildGraphOrder(
    graph: DependencyGraph<Package>,
    packageNamesToUpdate: string[]
  ): Package[] {
    if (this.merge) {
      return super.buildGraphOrder(graph, packageNamesToUpdate);
    }
    const selected = new Set(packageNamesToUpdate);
    this.dependencyVersions = new Map();
    for (const [name, {value: pkg}] of graph) {
      const candidate = this.candidatesByPackage[name];
      const version =
        candidate?.pullRequest.version ??
        (selected.has(name)
          ? this.bumpVersion(pkg)
          : this.releasesByPath[pkg.path]?.tag.version);
      if (version) this.dependencyVersions.set(name, version);
    }
    // Continue until transitive dependents have seen every proposed version.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, {value: pkg, deps}] of graph) {
        if (selected.has(name)) continue;
        if (
          deps.some(dep => {
            const target = this.dependencyVersions.get(dep);
            const acknowledged = this.acknowledgedVersions.get(name)?.get(dep);
            if (!target) return false;
            return (
              acknowledged &&
              semver.gt(target.toString(), acknowledged.toString())
            );
          })
        ) {
          selected.add(name);
          this.dependencyVersions.set(name, this.bumpVersion(pkg));
          changed = true;
        }
      }
    }
    return super
      .buildGraphOrder(graph, [...selected])
      .filter(pkg => selected.has(pkg.name));
  }

  protected async buildUpdatedVersions(
    graph: DependencyGraph<Package>,
    orderedPackages: Package[],
    candidatesByPackage: Record<string, CandidateReleasePullRequest>
  ): Promise<{updatedVersions: VersionsMap; updatedPathVersions: VersionsMap}> {
    const result = await super.buildUpdatedVersions(
      graph,
      orderedPackages,
      candidatesByPackage
    );
    if (!this.merge) {
      for (const [name, version] of this.dependencyVersions) {
        if (!result.updatedVersions.has(name))
          result.updatedVersions.set(name, version);
      }
    }
    return result;
  }

  private versionsForPackage(pkg: Package, versions: VersionsMap): VersionsMap {
    if (this.merge) return versions;
    const result: VersionsMap = new Map();
    const ownVersion = versions.get(pkg.name);
    if (ownVersion) result.set(pkg.name, ownVersion);
    for (const dep of Object.keys(this.combineDeps(pkg))) {
      const target = versions.get(dep);
      const acknowledged = this.acknowledgedVersions.get(pkg.name)?.get(dep);
      if (
        target &&
        acknowledged &&
        semver.gt(target.toString(), acknowledged.toString())
      ) {
        result.set(dep, target);
      }
    }
    return result;
  }

  private async acknowledgmentNotes(pkg: Package): Promise<string> {
    const release = this.releasesByPath[pkg.path];
    if (!release || release.notes.trim()) return release?.notes ?? '';
    if (!release.sha) return '';
    try {
      const contents = await this.github.getFileContentsOnBranch(
        addPath(
          pkg.path,
          this.repositoryConfig[pkg.path].changelogPath ?? 'CHANGELOG.md'
        ),
        release.sha
      );
      return this.releaseChangelogNotes(contents.parsedContent);
    } catch (error) {
      if (!(error instanceof FileNotFoundError)) throw error;
      return '';
    }
  }

  private releaseChangelogNotes(changelog: string): string {
    const lines = changelog.split('\n');
    const sections: string[] = [];
    let versioned = false;
    for (const line of lines) {
      if (/^##\s+\[?v?\d+\.\d+\.\d+/.test(line)) {
        versioned = true;
      }
      if (versioned) sections.push(line);
    }
    return sections.join('\n');
  }

  private dependencyNoteVersions(notes: string): VersionsMap {
    const versions: VersionsMap = new Map();
    for (const line of notes.split('\n')) {
      const trimmed = line.trim();
      const marker = trimmed.indexOf(' bumped ');
      if (!trimmed.startsWith('* ') || marker < 0) continue;
      const recorded = semver.valid(
        trimmed
          .slice(trimmed.lastIndexOf(' to ') + 4)
          .replace(/^[~^<>= ]+/, '')
          .trim()
      );
      if (recorded) {
        const name = trimmed.slice(2, marker);
        const existing = versions.get(name);
        if (!existing || semver.gt(recorded, existing.toString())) {
          versions.set(name, Version.parse(recorded));
        }
      }
    }
    return versions;
  }

  private async acknowledgedDependencyVersion(
    pkg: Package,
    dependency: Package,
    range: string,
    recordedVersion?: Version
  ): Promise<Version> {
    const release = this.releasesByPath[pkg.path];
    const dependencyRange = range.replace(/^workspace:/, '');
    let version =
      semver.valid(dependencyRange.replace(/^[~^<>= ]+/, '')) ??
      semver.coerce(dependencyRange)?.version;
    // Workspace shorthand does not store the dependency version. Its release
    // notes record proposed versions even when the consumer is merged first.
    const workspaceShorthand = range.startsWith('workspace:') && !version;
    if (workspaceShorthand) {
      version = dependency.version;
    }
    if (release?.sha) {
      try {
        const contents = await this.github.getFileContentsOnBranch(
          addPath(dependency.path, 'package.json'),
          release.sha
        );
        const released = JSON.parse(contents.parsedContent).version;
        if (workspaceShorthand || !version || semver.gt(released, version)) {
          version = released;
        }
      } catch (error) {
        if (!(error instanceof FileNotFoundError)) throw error;
      }
    }
    if (
      recordedVersion &&
      (!version || semver.gt(recordedVersion.toString(), version))
    ) {
      version = recordedVersion.toString();
    }
    return Version.parse(version ?? dependency.version);
  }

  protected inScope(candidate: CandidateReleasePullRequest): boolean {
    return candidate.config.releaseType === 'node';
  }

  protected packageNameFromPackage(pkg: Package): string {
    return pkg.name;
  }

  protected pathFromPackage(pkg: Package): string {
    return pkg.path;
  }

  private combineDeps(packageJson: Package): Record<string, string> {
    return {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
      ...(this.updatePeerDependencies
        ? packageJson.peerDependencies ?? {}
        : {}),
    };
  }

  async preconfigure(
    strategiesByPath: Record<string, Strategy>,
    _commitsByPath: Record<string, Commit[]>,
    _releasesByPath: Record<string, Release>
  ): Promise<Record<string, Strategy>> {
    // Using preconfigure to siphon releases and strategies.
    this.strategiesByPath = strategiesByPath;
    this.releasesByPath = _releasesByPath;

    return strategiesByPath;
  }
}

function getChangelogDepsNotes(
  original: Package,
  updated: Package,
  updateVersions: VersionsMap,
  logger: Logger
): string {
  let depUpdateNotes = '';
  type DT =
    | 'dependencies'
    | 'devDependencies'
    | 'peerDependencies'
    | 'optionalDependencies';
  const depTypes: DT[] = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  const updates: Map<DT, string[]> = new Map();
  for (const depType of depTypes) {
    const depUpdates = [];
    const pkgDepTypes = updated[depType];
    if (pkgDepTypes === undefined) {
      continue;
    }
    for (const [depName, currentDepVer] of Object.entries(pkgDepTypes)) {
      const newVersion = updateVersions.get(depName);
      if (!newVersion) {
        logger.debug(`${depName} was not bumped, ignoring`);
        continue;
      }
      const origDepVer = original[depType]?.[depName];
      const newVersionString = newVersionWithRange(origDepVer, newVersion);
      if (currentDepVer.startsWith('workspace:')) {
        depUpdates.push(`\n    * ${depName} bumped to ${newVersionString}`);
      } else if (newVersionString !== origDepVer) {
        depUpdates.push(
          `\n    * ${depName} bumped from ${origDepVer} to ${newVersionString}`
        );
        //handle case when "workspace:" version is used
      }
    }
    if (depUpdates.length > 0) {
      updates.set(depType, depUpdates);
    }
  }
  for (const [dt, notes] of updates) {
    depUpdateNotes += `\n  * ${dt}`;
    for (const note of notes) {
      depUpdateNotes += note;
    }
  }
  if (depUpdateNotes) {
    return `* The following workspace dependencies were updated${depUpdateNotes}`;
  }
  return '';
}
