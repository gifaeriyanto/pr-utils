#!/usr/bin/env node

import { Command } from 'commander';
import { createStagingPR } from './commands/create-staging-pr';

const program = new Command();

program
  .name('pr-utils')
  .description('CLI tools for PR-related operations')
  .version('1.0.0');

program
  .command('create-staging-pr')
  .description('Create a PR for staging by cherry-picking changes from a feature branch')
  .option('-f, --feature-branch <branch>', 'Feature branch name (e.g., feat/xxx)')
  .option('-s, --staging-branch <branch>', 'Staging branch name', 'staging')
  .option('-d, --develop-branch <branch>', 'Develop branch name', 'develop')
  .option('--dry-run', 'Show what would be done without actually doing it')
  .option('--include-merges', 'Include merge commits (default: exclude merge commits)')
  .option('--first-parent', 'Only include commits on the first parent (direct commits only)')
  .option('--include-sub-branches', 'Include commits from sub-branches that originated from the feature branch')
  .option('--sub-branch-pattern <pattern>', 'Pattern to match sub-branches (default: feature-branch name + "*")')
  .option('--branches <branches>', 'Comma-separated list of all branches to include (overrides feature-branch and sub-branch detection)')
  .action(createStagingPR);

program.parse();