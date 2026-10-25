# GitHub Pusher Studio User Guide

## Add a project

Use **Add Project** and select a project directory. The project is copied into the account's persistent library.

Every selected file must arrive at its own path. The browser sends the list of files it selected, and the server compares it with what it received. If any file is missing, has the wrong size, has an unsafe name, or shares its path with another file, nothing is stored and the error lists the files. Some phone browsers drop the folder structure when you pick a folder; the app detects this and refuses the upload rather than mixing files from different subfolders.

Projects added before this check existed were stored with every file at the top level, and files with the same name in different folders overwrote each other. Remove those projects and add them again.

## Open and edit a project

Select a project and choose **Open Selected**. Click a folder to browse its contents; use **Root** or **↑** to navigate back. Click a file to view and edit it. Existing UTF-8 text files up to 2 MiB are supported. Binary files and Git metadata remain unchanged.

Choose **Save file** or press Ctrl/⌘ + S to persist the edit to your app workspace. The original folder uploaded from your phone or computer is unchanged, and saving does not commit to GitHub. A safety snapshot is saved before each changed file. Saving an unchanged file creates no new version.

Save or discard a draft before fetching or pushing. Switching projects, opening another file, closing the editor or leaving the page protects unsaved work. If another tab/device or a GitHub pull changed the file after you opened it, the save is rejected. Keep a copy of your draft and reopen the file to review the latest contents.

## Fetch Changes

Choose **Fetch Changes** to pull the connected branch into the app workspace. The editor reloads saved file contents afterward. If both your saved project and GitHub changed, the existing pull safety checks keep your edits and report a conflict. Review the project status; pushing offers the existing explicit conflict choice.

## Remove a project

Select the project and choose **Remove**. Removing it from the library does not delete the corresponding GitHub repository.

## Connect GitHub

Choose **Connect GitHub** and complete GitHub authorization. No personal access token needs to be pasted into the site.

## Push

Select a project, choose **Push Selected**, then choose a repository and branch and press **Push**. The connected repository is selected by default. If no repository is selected, create a new repository from the push dialog.

If the project has no `.git` directory, the server initializes it automatically before the first push.

The **Commit message** field is optional. Enter your own text to use it as the commit message, including multiple lines. Leave it blank or whitespace-only to keep the automatic timestamped message. No new commit is created when files are unchanged. Your message is kept if pushing fails or you cancel the dialog.

Push safety rules:

- A project is only added once its files are verifiably saved to cloud storage. If saving fails, Add Project shows an error instead of creating an empty project.
- Before anything is sent to GitHub, the stored copy is restored and checked file-by-file against the list recorded when it was saved. If anything is missing, the push fails and no repository is created.
- Pushes never force-overwrite GitHub. Your commit is built on top of the branch's current history. If someone else pushes while yours is running, the push stops and asks you to try again.
- Files changed on GitHub that you did not change are kept. If the same file changed in both places, the push stops and lists the files. You then choose to overwrite them with your versions or cancel.
- A push only reports success after GitHub shows the new commit with the expected number of files. If nothing changed, it says so instead of making an empty commit.
- Before a new repository is created, the app proves git can use your GitHub login and stages your files locally, so problems found on the server never leave a repository behind.
- If a push into a repository it just created still fails, what happens depends on whether the server operator enabled the `delete_repo` permission (off by default):
  - Without it, the repository stays. The error names it and links to it, and it is linked to the project, so pushing again fills that same repository instead of creating another. Delete it on GitHub if you don't want it.
  - With it, the app deletes the repository, but only after confirming on GitHub that nothing landed in it.
  - If the push was cut off by a timeout, nothing is deleted; the error links to the repository so you can check it.

## Automatic pull

Tracked projects are checked periodically. When the remote repository has a fast-forward update and the local working tree is clean, the server pulls it automatically.

If local changes are present, automatic pull is blocked and the project is marked as needing attention instead of overwriting work.

## Snapshots

Before and after important synchronization events the service stores a snapshot under the project's snapshot history.
