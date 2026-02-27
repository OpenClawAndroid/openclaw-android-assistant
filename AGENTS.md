# AGENTS.md

## Detached HEAD: Merge To Local `main` Without Creating A Branch

- If working in detached `HEAD`, commit there first.
- Then apply that commit onto local `main` from the main worktree using fast-forward merge or cherry-pick.

## Merging Worktree Branch to Main With Conflicts

When merging a worktree branch into `main` and conflicts arise:

1. Run `git merge <branch> --no-commit` from the main worktree (`/Users/igor/Git-projects/codex-web-local`).
2. Identify conflicted files with `git diff --name-only --diff-filter=U`.
3. For each conflicted file, resolve using a Python script that replaces the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) with the correctly merged content — keeping changes from **both** sides.
4. Do **not** blindly `--ours` or `--theirs` — manually combine both sides.
5. After fixing, `git add <file>` and `git commit`.
6. Note: the worktree workspace (`zpw/`) is restricted — `StrReplace` tool cannot edit files in the main worktree. Use `Shell` or a Python script instead.

## Commit After Each Task

- Always create a commit after completing each discrete task or sub-task.
- Do not batch multiple tasks into a single commit.
- Each commit message should describe the specific change made.

## Completion Verification Requirement

- After completing a task that changes behavior or UI, always run a Playwright verification in headless mode.
- Before taking any screenshot, wait a few seconds to ensure the UI has fully loaded.
- Always capture a screenshot of the changed result and display that screenshot in chat when reporting completion.
