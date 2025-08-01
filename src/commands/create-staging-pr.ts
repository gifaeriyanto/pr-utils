import { simpleGit, SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';
import chalk from 'chalk';
import ora from 'ora';

interface CreateStagingPROptions {
  featureBranch?: string;
  stagingBranch: string;
  developBranch: string;
  dryRun?: boolean;
  includeMerges?: boolean;
  firstParent?: boolean;
  includeSubBranches?: boolean;
  subBranchPattern?: string;
  branches?: string;
}

export async function createStagingPR(options: CreateStagingPROptions) {
  const git: SimpleGit = simpleGit();
  const spinner = ora();

  try {
    // Handle manual branch specification
    if (options.branches) {
      const manualBranches = options.branches.split(',').map(b => b.trim());
      console.log(chalk.blue(`Using manually specified branches: ${manualBranches.join(', ')}`));
      
      // Use the first branch as the primary feature branch for validation
      if (!options.featureBranch) {
        options.featureBranch = manualBranches[0];
      }
    } else if (!options.featureBranch) {
      const currentBranch = await git.branch();
      options.featureBranch = currentBranch.current;
      console.log(chalk.blue(`Using current branch: ${options.featureBranch}`));
    }

    if (
      options.featureBranch === options.stagingBranch ||
      options.featureBranch === options.developBranch
    ) {
      console.error(
        chalk.red(
          'Feature branch cannot be the same as staging or develop branch'
        )
      );
      process.exit(1);
    }

    spinner.start('Checking repository status...');

    const status = await git.status();
    if (!status.isClean()) {
      spinner.fail(
        'Working directory is not clean. Please commit or stash your changes.'
      );
      process.exit(1);
    }

    spinner.succeed('Repository status is clean');

    spinner.start('Fetching latest changes...');
    await git.fetch();
    spinner.succeed('Fetched latest changes');

    spinner.start('Checking if branches exist...');
    const branches = await git.branch(['-a']);

    const hasFeatureBranch =
      branches.all.includes(options.featureBranch) ||
      branches.all.includes(`remotes/origin/${options.featureBranch}`);
    const hasStagingBranch =
      branches.all.includes(options.stagingBranch) ||
      branches.all.includes(`remotes/origin/${options.stagingBranch}`);
    const hasDevelopBranch =
      branches.all.includes(options.developBranch) ||
      branches.all.includes(`remotes/origin/${options.developBranch}`);

    if (!hasFeatureBranch) {
      spinner.fail(`Feature branch '${options.featureBranch}' not found`);
      process.exit(1);
    }
    if (!hasStagingBranch) {
      spinner.fail(`Staging branch '${options.stagingBranch}' not found`);
      process.exit(1);
    }
    if (!hasDevelopBranch) {
      spinner.fail(`Develop branch '${options.developBranch}' not found`);
      process.exit(1);
    }

    spinner.succeed('All required branches exist');

    // Determine branches to process
    let branchesToProcess: string[] = [];
    
    if (options.branches) {
      // Use manually specified branches
      branchesToProcess = options.branches.split(',').map(b => b.trim());
      console.log(chalk.green(`Processing ${branchesToProcess.length} manually specified branches`));
    } else {
      // Use feature branch + auto-detected sub-branches
      let subBranches: string[] = [];
      if (options.includeSubBranches) {
        spinner.start('Finding sub-branches...');
        
        const pattern = options.subBranchPattern || `${options.featureBranch}*`;
        const allBranches = await git.branch(['-r']);
        
        // Filter branches that match the pattern and exclude the main feature branch
        subBranches = allBranches.all
          .filter(branch => branch.startsWith('origin/'))
          .map(branch => branch.replace('origin/', ''))
          .filter(branch => {
            // Match pattern and exclude the main feature branch itself
            const isMatch = branch !== options.featureBranch && 
                           (branch.startsWith(pattern.replace('*', '')) || 
                            new RegExp(pattern.replace('*', '.*')).test(branch));
            return isMatch;
          });

        if (subBranches.length > 0) {
          spinner.succeed(`Found ${subBranches.length} sub-branches: ${subBranches.join(', ')}`);
        } else {
          spinner.succeed('No sub-branches found');
        }
      }
      
      branchesToProcess = [options.featureBranch, ...subBranches];
    }
    
    spinner.start(
      `Getting commits from ${branchesToProcess.length > 1 ? `${branchesToProcess.length} branches` : options.featureBranch} that are not in ${options.stagingBranch}...`
    );

    // Build additional git arguments for filtering
    const additionalArgs: string[] = [];
    
    if (!options.includeMerges) {
      additionalArgs.push('--no-merges');
    }
    
    if (options.firstParent) {
      additionalArgs.push('--first-parent');
    }

    // Collect commits from all branches
    const allCommits: any[] = [];
    const commitHashes = new Set<string>(); // To avoid duplicates

    for (const branch of branchesToProcess) {
      try {
        let branchCommits;
        
        if (additionalArgs.length > 0) {
          const gitArgs = [
            'log',
            `origin/${options.stagingBranch}..origin/${branch}`,
            '--oneline',
            '--format=%H|%s|%an|%ad|%d',
            '--date=iso',
            ...additionalArgs,
          ];
          
          const rawOutput = await git.raw(gitArgs);
          const commits = rawOutput
            .trim()
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
              const [hash, message, author, date, refs] = line.split('|');
              return {
                hash,
                message: message || '',
                author_name: author || '',
                date: date || '',
                refs: refs || '',
                branch: branch, // Track which branch this commit came from
              };
            });
          
          branchCommits = commits;
        } else {
          const logResult = await git.log({
            from: `origin/${options.stagingBranch}`,
            to: `origin/${branch}`,
          });
          branchCommits = logResult.all.map(commit => ({
            ...commit,
            branch: branch,
          }));
        }

        // Add unique commits
        for (const commit of branchCommits) {
          if (!commitHashes.has(commit.hash)) {
            commitHashes.add(commit.hash);
            allCommits.push(commit);
          }
        }
      } catch (error) {
        console.warn(chalk.yellow(`Warning: Could not get commits from branch ${branch}: ${error}`));
      }
    }

    // Sort all commits by date (chronological order, oldest first)
    allCommits.sort((a, b) => {
      const dateA = new Date(a.date || a.author_date || 0);
      const dateB = new Date(b.date || b.author_date || 0);
      return dateA.getTime() - dateB.getTime();
    });

    const featureCommits = {
      all: allCommits,
      total: allCommits.length,
    };

    if (featureCommits.total === 0) {
      spinner.fail(
        `No commits found in ${options.featureBranch} that are not in ${options.stagingBranch}`
      );
      process.exit(1);
    }

    spinner.succeed(`Found ${featureCommits.total} commits to cherry-pick`);

    console.log(chalk.yellow('Commits to be cherry-picked (newest first):'));
    // Display in reverse chronological order (newest first) for better readability
    [...featureCommits.all].reverse().forEach((commit, index) => {
      const branchInfo = commit.branch && commit.branch !== options.featureBranch 
        ? chalk.cyan(` [${commit.branch}]`) 
        : '';
      console.log(
        chalk.gray(
          `  ${index + 1}. ${commit.hash.substring(0, 7)} - ${commit.message}${branchInfo}`
        )
      );
    });

    if (options.dryRun) {
      console.log(chalk.green('\nDry run completed. No changes were made.'));
      return;
    }

    const stagingPRBranch = `staging-pr-${options.featureBranch.replace('/', '-')}-${Date.now()}`;

    spinner.start(
      `Creating new branch '${stagingPRBranch}' from ${options.stagingBranch}...`
    );
    await git.checkout([
      '-b',
      stagingPRBranch,
      `origin/${options.stagingBranch}`,
    ]);
    spinner.succeed(`Created branch '${stagingPRBranch}'`);

    spinner.start('Cherry-picking commits...');
    // Commits are now already sorted in chronological order (oldest first)
    // Cherry-pick them in this order
    console.log(chalk.gray(`Cherry-picking ${featureCommits.all.length} commits in chronological order...`));

    for (const commit of featureCommits.all) {
      try {
        await git.raw(['cherry-pick', commit.hash]);
      } catch (error) {
        spinner.fail(`Failed to cherry-pick commit ${commit.hash}: ${error}`);
        console.log(
          chalk.yellow(
            'You may need to resolve conflicts manually and continue with:'
          )
        );
        console.log(chalk.white(`  git cherry-pick --continue`));
        console.log(chalk.yellow('Or abort with:'));
        console.log(chalk.white(`  git cherry-pick --abort`));
        process.exit(1);
      }
    }

    spinner.succeed('All commits cherry-picked successfully');

    spinner.start(`Pushing branch '${stagingPRBranch}' to origin...`);
    await git.push('origin', stagingPRBranch);
    spinner.succeed(`Pushed branch '${stagingPRBranch}' to origin`);

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      console.log(
        chalk.yellow('\nGITHUB_TOKEN not found. Please create PR manually:')
      );
      console.log(
        chalk.white(
          `  gh pr create --base ${options.stagingBranch} --head ${stagingPRBranch} --title "Cherry-pick changes from ${options.featureBranch} to staging" --body "Cherry-picked commits from ${options.featureBranch}"`
        )
      );
      return;
    }

    const remoteUrl = await git.getConfig('remote.origin.url');
    const match = remoteUrl.value?.match(/github\.com[:/]([^/]+)\/([^.]+)/);

    if (!match) {
      console.log(
        chalk.yellow('Could not parse GitHub repository from remote URL')
      );
      console.log(
        chalk.white(
          `Please create PR manually from branch '${stagingPRBranch}' to '${options.stagingBranch}'`
        )
      );
      return;
    }

    const [, owner, repo] = match;
    const repoName = repo.replace('.git', '');

    spinner.start('Creating GitHub PR...');

    const octokit = new Octokit({
      auth: githubToken,
    });

    const branchList = branchesToProcess.length > 1 
      ? branchesToProcess.join(', ')
      : options.featureBranch;
      
    const prBody = `Cherry-picked changes from ${branchList} to staging

## Commits included:
${featureCommits.all.map((commit, index) => {
  const branchInfo = commit.branch && commit.branch !== options.featureBranch 
    ? ` [${commit.branch}]` 
    : '';
  return `${index + 1}. ${commit.hash.substring(0, 7)} - ${commit.message}${branchInfo}`;
}).join('\n')}

---
*Generated by pr-utils*`;

    const pr = await octokit.rest.pulls.create({
      owner,
      repo: repoName,
      title: `Cherry-pick changes from ${branchList} to staging`,
      head: stagingPRBranch,
      base: options.stagingBranch,
      body: prBody,
    });

    spinner.succeed(`Created PR #${pr.data.number}: ${pr.data.html_url}`);

    console.log(chalk.green(`\n✅ Successfully created staging PR!`));
    console.log(chalk.blue(`   PR URL: ${pr.data.html_url}`));
  } catch (error) {
    spinner.fail(`Error: ${error}`);
    process.exit(1);
  }
}
