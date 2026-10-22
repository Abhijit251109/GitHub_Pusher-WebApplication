# User Guide

## Add a project

Use **Add Project** and select a project directory. The project is copied into the account's persistent library.

Every selected file must arrive at its own path. The browser sends the list of files it selected, and the server compares it with what it received. If any file is missing, has the wrong size, has an unsafe name, or shares its path with another file, nothing is stored and the error lists the files. Some phone browsers drop the folder structure when you pick a folder; the app detects this and refuses the upload rather than mixing files from different subfolders.

Projects added before this check existed were stored with every file at the top level, and files with the same name in different folders overwrote each other. Remove those projects and add them again.

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
- Before a new repository is created, the app proves git can use your GitHub login and stages your files locally, so problems found on the server never leave a repository behind.
- New repositories are only created when your login includes the `delete_repo` permission. If a push into a repository it just created fails, the app deletes that repository, but only after confirming on GitHub that nothing landed in it. If you signed in before this permission was requested, sign out and sign in again; pushing into existing repositories works without it. If the push was cut off by a timeout, the error message links to the repository so you can check it.

## Automatic pull

Tracked projects are checked periodically. When the remote repository has a fast-forward update and the local working tree is clean, the server pulls it automatically.

If local changes are present, automatic pull is blocked and the project is marked as needing attention instead of overwriting work.

## Snapshots

Before and after important synchronization events the service stores a snapshot under the project's snapshot history.
