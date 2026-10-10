# Optima Pad

A calm notes app for Windows. One note, one file. Write in the middle, drop loose thoughts anywhere around it.

Free, no account, no ads, no telemetry. Part of [optima machina](https://optimamachina.world). More about it on [its page](https://optimamachina.world/shelf/optima-pad/).

**[Download the latest version](https://github.com/optimamachina/optima-pad/releases/latest)** (Windows 10 / 11, 64-bit)

Windows may say "Windows protected your PC" because the installer isn't code-signed yet. Click **More info**, then **Run anyway**.

## What it does

- One window, one note, one `.opad` file you own
- Click anywhere outside the column to drop a floating note; drag its right edge to set its width
- Doodle boxes for quick sketches
- Quick note from anywhere with Ctrl+Alt+O
- Find (Ctrl+F), word count, dividers, indents (Tab) and strikethrough (Ctrl+-)
- Ctrl+1 text size, Ctrl+2 colour, Ctrl+3 soft box, Ctrl+4 (or middle-click) themes, fonts, doodles and recent notes
- Pin a note on top of other windows; Ctrl+Shift+T reopens the last closed note
- Six themes, six reading fonts, or your own photo as the background
- Lock any note with a password (AES-256-GCM, key derived with scrypt; the password is never stored)
- Saves itself as you type

## Build it yourself

You need [Node.js](https://nodejs.org).

```
npm install
npm start        # run it
npm run dist     # build the Windows installer into dist/
```

## Ingredients

The code was written with Claude. The idea, every design decision and the testing are human.

## License

[MIT](LICENSE)
