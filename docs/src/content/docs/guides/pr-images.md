---
title: Images on pull requests
description: How agents attach screenshots to their pull requests with ost pr attach, where GitHub stores them, what the repository's rules must allow, and why an image hosted elsewhere does not render.
---

When the repository or the ticket asks for screenshots of UI work, the developer attaches them to the ticket and to the pull request, so whoever reviews it on the code host sees them there. The designer's review reads them in either place.

## Attach an image

```sh
ost pr attach 42 /scratch/w1/cart-empty.png --alt "Empty cart"
```

[`ost pr attach`](/reference/agent-verbs/#prattach) stores the image for pull request 42 where the code host renders it, and prints the markdown that shows it, for example:

```md
![Empty cart](https://github.com/acme/shop/blob/outstaff-assets/42/cart-empty.png?raw=true)
```

The agent puts that markdown in the pull request's description (`ost pr update --body-file`) or in a comment (`ost pr comment`). The verb takes a png, jpeg, gif or webp of at most 10 MB from the item's scratch directory or the worktree; its type is read from the file's bytes, and its name must end in that type's extension. An image of the same name for the same pull request replaces the earlier one.

It acts as the agent's own identity and needs a write grant on the repository, like the other `pr` writes. A chat session cannot call it: chat sessions change no pull request. On a code host whose adapter cannot store images, it is refused with `unsupported`, and the screenshot goes on the ticket only (`ost ticket attach`).

## The `vcs.images` capability

A vcs adapter that can store images declares the `vcs.images` capability and implements `storeImage(repo, number, image)` on the port. It stores the file for the pull request and returns a link that the host's markdown renders, with the path it stored it at. It refuses a file that is not one of the four image types or is over the cap (`invalid`), an unknown pull request (`not_found`) and a person without a write grant (`forbidden`).

## On GitHub

The GitHub adapter commits each image to a dedicated **assets branch** of the repository, `outstaff-assets` by default, at `<pr number>/<file name>`, as the agent's own GitHub App. The first image creates the branch as an orphan (a commit with no parent), so nothing reaches the default branch or its history; later images add to its tree. The link is the file's `blob/<branch>/<path>?raw=true` URL, which GitHub serves with the viewer's own access, so it renders in a private repository too.

To use another branch, set the adapter's `assetsBranch` option:

```yaml
integrations:
  vcs:
    adapter: github
    assetsBranch: pr-images
```

The App needs nothing beyond what a write grant already asks for (Contents: read and write). The repository's rules must let it create the branch and push to it directly: a ruleset that restricts creating or updating branches, or asks for a pull request or status checks before a push, applies to the assets branch as to any other unless it is excluded. [`ost doctor`](/guides/doctor/) reads the rules that apply to the branch in each repository the person can write and warns when one of them would stop it, naming the rules. Exclude `refs/heads/outstaff-assets` from those rulesets, or add the agents' Apps to their bypass list.

Images stay on the branch after the pull request is merged or closed; nothing removes them yet.

## Why an image hosted elsewhere does not render

GitHub rewrites every image URL in a description or a comment to its image proxy (camo), which fetches the file from GitHub's servers, not from the viewer's browser. A tracker on a private network (`tracker.acme.example`) cannot be reached from there, and a tracker's attachments need a login or are short-lived signed links, so a link to the ticket's attachment shows as a broken image. A file stored in the repository itself is served by GitHub, so it renders.
