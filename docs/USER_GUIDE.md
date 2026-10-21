# User Guide

## Add a project

Use **Add Project** and select a project directory. The project is copied into the account's persistent library.

## Remove a project

Select the project and choose **Remove**. Removing it from the library does not delete the corresponding GitHub repository.

## Connect GitHub

Choose **Connect GitHub** and complete GitHub authorization. No personal access token needs to be pasted into the site.

## Push

Select a project, choose a repository, then press **Push to GitHub**. If no repository is selected, create a new repository from the push dialog.

If the project has no `.git` directory, the server initializes it automatically before the first push.

Push safety rules:

- A project is only added once its files are verifiably saved to cloud storage. If saving fails, Add Project shows an error instead of creating an empty project.
- Before anything is sent to GitHub, the stored copy is restored and checked file-by-file against the list recorded when it was saved. If anything is missing, the push fails and no repository is created.
- Pushes never force-overwrite GitHub. Your commit is built on top of the branch's current history. If someone else pushes while yours is running, the push stops and asks you to try again.
- Files changed on GitHub that you did not change are kept. If the same file changed in both places, the push stops and lists the files. You then choose to overwrite them with your versions or cancel.
- A push only reports success after GitHub shows the new commit with the expected number of files. If nothing changed, it says so instead of making an empty commit.
- If a push into a repository it just created fails, the app tries to delete that empty repository. Deleting needs the `delete_repo` scope in `GITHUB_OAUTH_SCOPE`; without it the error message says the empty repository exists and links to it.

## Automatic pull

Tracked projects are checked periodically. When the remote repository has a fast-forward update and the local working tree is clean, the server pulls it automatically.

If local changes are present, automatic pull is blocked and the project is marked as needing attention instead of overwriting work.

## Snapshots

Before and after important synchronization events the service stores a snapshot under the project's snapshot history.
