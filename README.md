# prompt-history

Minimal Chrome extension that lets you navigate your submitted prompts with the up and down arrow keys, like a terminal. <br>Works on ChatGPT.<br>
![Demo](https://github.com/user-attachments/assets/d8300650-1c80-4edf-ad42-336f6390df50)

## Install

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable "Developer mode" (toggle in the top right).
4. Click "Load unpacked" and select the folder containing `manifest.json`.

## How it works

- Press Up arrow when the cursor is on the first line of the input to go to the previous prompt.
- Press Down arrow when the cursor is on the last line to go forward.
- If you have typed something and press Up, your draft is saved and restored when you press Down past the end of history.
- History is normally per-tab, but when opening preexisting chats, it scrapes your previously submitted prompts for that chat to populate the history buffer. Nothing is saved to disk.

## Supported sites

- chatgpt.com

## License

MIT
