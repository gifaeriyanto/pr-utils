import { simpleGit, SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';
import chalk from 'chalk';
import ora from 'ora';

interface CreateStagingPROptions {
  featureBranch?: string;
  stagingBranch: string;
  developBranch: string;
  dryRun?: boolean;
}

export async function createStagingPR(options: CreateStagingPROptions) {
  const git: SimpleGit = simpleGit();
  const spinner = ora();

  try {
    if (!options.featureBranch) {
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

    spinner.start(
      `Getting commits from ${options.featureBranch} that are not in ${options.developBranch}...`
    );

    const featureCommits = await git.log({
      from: `origin/${options.developBranch}`,
      to: `origin/${options.featureBranch}`,
    });

    if (featureCommits.total === 0) {
      spinner.fail(
        `No commits found in ${options.featureBranch} that are not in ${options.developBranch}`
      );
      process.exit(1);
    }

    spinner.succeed(`Found ${featureCommits.total} commits to cherry-pick`);

    console.log(chalk.yellow('Commits to be cherry-picked:'));
    [...featureCommits.all].reverse().forEach((commit, index) => {
      console.log(
        chalk.gray(
          `  ${index + 1}. ${commit.hash.substring(0, 7)} - ${commit.message}`
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
    const commitsToPickReversed = [...featureCommits.all].reverse();

    for (const commit of commitsToPickReversed) {
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

    const prBody = `Cherry-picked changes from ${options.featureBranch} to staging

## Commits included:
${featureCommits.all.map((commit, index) => `${index + 1}. ${commit.hash.substring(0, 7)} - ${commit.message}`).join('\n')}

---
*Generated by pr-utils*`;

    const pr = await octokit.rest.pulls.create({
      owner,
      repo: repoName,
      title: `Cherry-pick changes from ${options.featureBranch} to staging`,
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
