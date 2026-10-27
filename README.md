# chatgpt-image

A Claude Code skill that generates images through your ChatGPT Plus account. It drives a headless Chrome over CDP, sends the prompt to chatgpt.com, and saves the PNG where Claude needs it. No API key and no per-image billing, just your normal Plus limits.

macOS only for now (the Chrome path is hardcoded). Needs Node 22+ and Google Chrome.

## Install

```bash
git clone https://github.com/AUstnnnnnn/chatgpt-image ~/.claude/skills/chatgpt-image
node ~/.claude/skills/chatgpt-image/gen.mjs --login
```

`--login` opens a normal Chrome window on a separate profile. Sign in to ChatGPT, then quit that Chrome with ⌘Q. Every run after that is headless.

## Use

In Claude Code, type `/chatgpt-image a pixel art cat, transparent background`, or just ask Claude for an icon or a placeholder image and it picks the skill up. You can also run it directly:

```bash
node ~/.claude/skills/chatgpt-image/gen.mjs --out ./assets "Generate an image: ..."
node ~/.claude/skills/chatgpt-image/gen.mjs --ref photo.png "Generate an image: same scene at night"
node ~/.claude/skills/chatgpt-image/gen.mjs --library 4 --out ./assets   # pull your 4 latest images
```

`SKILL.md` has the full flag list and what to do when a run fails.

## Things to know

- This automates the ChatGPT website, which OpenAI's terms don't allow. They could flag your account. Use it on your own account and at your own risk.
- While Chrome is running, port 9334 is open on localhost and any program on your machine can use it to reach your signed-in ChatGPT session. Chrome quits itself after 10 minutes without a run, which closes the port.
- Finished chats are hidden from your ChatGPT history, not deleted. The images stay in your ChatGPT image library.
- If OpenAI changes the chatgpt.com page, the selectors in `gen.mjs` will need updating. The comments in the code say which ones.
