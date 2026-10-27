---
name: chatgpt-image
description: Generate images with ChatGPT (GPT image gen) by driving headless Chrome over CDP, then hand the PNG back for the current task. Use when the user invokes /chatgpt-image, or asks to generate, draw, render or mock up an image, icon, illustration, texture, hero art or placeholder asset via ChatGPT. Accepts a ready prompt or crafts one from context; can pass reference images for edits.
---

# ChatGPT image gen

Script: `~/.claude/skills/chatgpt-image/gen.mjs` (Node 22+, no deps). Uses the user's ChatGPT account in a dedicated Chrome profile on port 9334, headless (only `--login` opens a window).

## 1. Prompt

- Args after the invocation that read as a prompt: use them verbatim.
- Otherwise write the prompt(s) from the task context. Be concrete: subject, composition, style/medium, palette, lighting, aspect ratio ("square", "16:9 wide"), background ("transparent background" for assets), and any exact text in quotes. One image per prompt; several assets = several runs.
- Start the prompt with "Generate an image:" so ChatGPT uses the image tool instead of replying in text.

## 2. Run

```bash
node ~/.claude/skills/chatgpt-image/gen.mjs --out <dir> [--ref path.png]... "Generate an image: ..."
```

- `--out`: where the task needs it (project assets dir), else the scratchpad. Defaults to cwd.
- `--ref`: attach reference/source images for edits or style matching.
- The chat is hidden from ChatGPT history after the image is saved (not deleted: OpenAI keeps it, and the image stays in the account's image library). `--keep` leaves it visible (e.g. to continue it by hand). Failed runs keep their chat.
- Takes 30s to 3 min; parallel runs queue on ChatGPT's side (~1 min apart). Run with Bash `timeout: 360000`. Independent images: run in parallel in the background. Each run tracks only its own conversation through ChatGPT's API, so parallel runs can't pick up each other's images.
- Prints saved file path(s) on stdout, and `conversation: <id>` on stderr as soon as the chat exists.
- Each run closes its own tab on exit. Tabs left by killed runs are closed at the start of the next run.
- The headless Chrome quits itself after 10 min with no runs, which closes port 9334. The next run cold-starts it (a few seconds). Runs killed with SIGKILL skip this, so Chrome stays up until the next run finishes.

## Recovering images (never regenerate to recover)

If a run timed out, was killed, or you lost its output, the image is probably done anyway. Pull it from ChatGPT's image library; don't run the prompt again:

```bash
node ~/.claude/skills/chatgpt-image/gen.mjs --library --conv <conversation-id> --out <dir>   # that run's images
node ~/.claude/skills/chatgpt-image/gen.mjs --library 6 --out <dir>                          # 6 most recent
```

Prints one line per image: `path<TAB>title<TAB>conversation-id<TAB>created`. Read the files to match them to prompts.

## 3. Use the result

Read the printed file to look at it. Judge against intent; if off, refine the prompt (or pass the image back via `--ref` with a change request) and rerun. Max ~3 tries before showing the user. Then use the file for the task.

## Failures

- `not signed in`: tell the user to run `! node ~/.claude/skills/chatgpt-image/gen.mjs --login`, sign in, quit that Chrome, retry.
- `composer` timeout: likely a Cloudflare check. Same fix as above (visible login window clears it).
- `no image returned`: ChatGPT replied in text (refusal or rate limit). Script prints its reply and keeps the chat; relay or rephrase.
- `timed out waiting for image`: use `--library --conv <id>` (above) before anything else.
- Timeouts after a ChatGPT UI change: fix gen.mjs. The DOM is only used up to submit (`.ProseMirror` composer, `form button[type=submit]`, file input, `login-button`). From then on it's the backend API: `conversation/{id}`, `files/download/{file_id}`, `my/recent/image_gen`.
