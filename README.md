# Talk Converter

Point it at a recording of a multi-talk event and get back one video, transcript
and write-up per talk.

You don't time the talks yourself. The captions are read once and Claude works
out where each talk starts and ends — where the MC says "welcome to the stage",
where the Q&A wraps up — then every talk is cut, transcribed and written up in a
single pass.

![Talk Converter Preview](https://raw.githubusercontent.com/TrystonPerry/talk-converter/main/youtube-converter.png)

```bash
npm start -- "https://youtube.com/watch?v=example"
```

## Setup

1. **Prerequisites**

   - [Bun](https://bun.sh) (v1.3 or higher)
   - ffmpeg and ffprobe (cutting segments, reading the runtime)
   - yt-dlp (downloading source videos and captions)
   - [Claude Code](https://claude.com/claude-code), logged in (the AI passes)

2. **Installation**

   ```bash
   git clone [repository-url]
   cd talk-converter

   # System tools (Arch — ffprobe ships inside the ffmpeg package)
   sudo pacman -S ffmpeg yt-dlp

   # Claude Code, if you don't already have it: https://claude.com/claude-code
   claude   # log in once, then quit

   bun install
   ```

   There is no API key to manage. Both AI passes shell out to `claude --print`,
   so they use whatever Claude Code is already authenticated with.

## Usage

### Check the boundaries first

Detection is a judgement call made on messy auto-captions, so `--list` prints
what it found and stops before slicing anything:

```bash
npm start -- "https://youtube.com/watch?v=example" --list
```

```
14:22:07 STEP  [3/3] Identifying talks
14:22:07 INFO    cues parsed: 3589
14:22:07 INFO    runtime: 1:13:12
14:22:07 INFO    model: sonnet
14:22:07 INFO    prompt size: 69.1 KB
14:22:25 INFO    detection took: 18.1s
14:22:25 DONE  Identified 2 talks
14:22:25 INFO    1. Freedom with AI: Cammy and Sonia · 0:10:15–0:49:30 (39m 15s)
14:22:25 INFO    2. Designing with Claude Code: Tristan Perry · 0:52:30–1:07:45 (15m 15s)
```

Happy with those? Drop `--list` and run it again — the video and captions are
already cached, so it picks up from there.

### Options

| Flag | Effect |
| --- | --- |
| `--list` | Detect talks and print them, without slicing |
| `--verbose` | Show every command, its exit code, timing and full output |
| `--range start,end` | Skip detection and cut one segment (`H:MM:SS` or seconds) |
| `--title '...'` | Name for that segment — required with `--range` |

`LOG_LEVEL=debug` does the same as `--verbose`.

When detection gets a talk wrong, cut that one by hand rather than fighting it:

```bash
npm start -- "https://youtube.com/watch?v=example" \
  --range "52:30,1:07:45" --title "Designing with Claude Code"
```

### Output

Three files per talk in `__talks/`, named `{Speaker}_{Title}`:

| File | Contents |
| --- | --- |
| `.mp4` | The talk, cut from the source video |
| `.txt` | Its transcript, sliced out of the video's captions |
| `.md` | A video description and a full write-up, including the Q&A |

## How it works

```
video + captions ──▶ detect talks ──▶ per talk ──▶ cut segment
   (downloaded once)     (1 AI pass)                slice transcript
                                                    write summary (1 AI pass)
```

**Pass 1 — detection.** The whole caption file is folded into a transcript
where each line carries the time it was said, and Claude is asked to return the
talks as JSON. One timestamp per caption cue would roughly triple the token
count for precision a keyframe-snapped cut can't honour anyway, so lines are
bucketed into 15-second blocks. Everything that comes back is treated as
untrusted: the JSON is dug out of any code fencing, then each entry is checked,
with unusable talks dropped and ends past the runtime clamped.

**Pass 2 — summary.** Each talk's transcript is sliced out of the same caption
file and written up on its own. A summary that comes back missing its
`## Description` / `## Article` headings is a failure, not a file — otherwise a
model that replies with a clarifying question would leave you with a green run
and a useless `.md`.

Detection runs on **sonnet**: it happens once per video and has to reason about
where one talk ends and the next begins. Summaries run on **haiku** — one call
per talk, on a much smaller input. Both are set at the top of `index.ts`.

Downloads are cached in `__youtube/` and outputs in `__talks/`, and every step
skips itself if its output already exists, so a re-run after a failure only
redoes the part that failed.

## Notes and limitations

- **Captions are required.** Transcripts come from YouTube's own captions, so a
  video with them disabled won't work at all.
- **Detection is non-deterministic.** Boundaries shift a little between runs —
  across two runs of the same video one talk's start moved by 30 seconds. Both
  were defensible; it's still why `--list` exists.
- **Boundaries land on 15-second marks**, and `-c copy` snaps the cut to the
  nearest keyframe on top of that, so a segment can start or end a few seconds
  off. Fine for talks, not for frame-accurate work.
- **Speaker names come from auto-captions** and get misspelt — "Tryston" was
  heard as "Tristan", which then flows into the filename. Worth a glance before
  you publish.
- **One talk failing doesn't abort the batch.** The rest still run, the failures
  are listed at the end, and the exit code is non-zero.
