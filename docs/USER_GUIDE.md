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

## Automatic pull

Tracked projects are checked periodically. When the remote repository has a fast-forward update and the local working tree is clean, the server pulls it automatically.

If local changes are present, automatic pull is blocked and the project is marked as needing attention instead of overwriting work.

## Snapshots

Before and after important synchronization events the service stores a snapshot under the project's snapshot history.
