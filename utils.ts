export function getVideoId(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid YouTube URL: ${url}`);
  }

  const id =
    parsed.hostname === "youtu.be"
      ? parsed.pathname.slice(1)
      : parsed.searchParams.get("v");

  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    throw new Error(`Could not extract a video ID from: ${url}`);
  }

  return id;
}

export function timeToSeconds(time: string) {
  const parts = time.split(":");

  if (parts.length === 1) {
    // Just seconds
    return parseInt(parts[0]);
  } else if (parts.length === 2) {
    // Minutes and seconds
    const [minutes, seconds] = parts;
    return parseInt(minutes) * 60 + parseInt(seconds);
  } else if (parts.length === 3) {
    // Hours, minutes and seconds
    const [hours, minutes, seconds] = parts;
    return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);
  }

  throw new Error("Invalid time format");
}

type Cue = { start: number; end: number; lines: string[] };

function vttTimeToSeconds(time: string) {
  const [clock, milliseconds = "0"] = time.split(".");
  const seconds = clock
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);

  return seconds + Number(milliseconds) / 1000;
}

// Scanned line by line rather than split on blank lines: auto-captions put a
// blank line between a cue's timing row and its text, which would orphan it.
export function parseVtt(vtt: string): Cue[] {
  const rows = vtt.replace(/\r\n/g, "\n").split("\n");
  const cues: Cue[] = [];
  let current: Cue | null = null;

  for (const [index, row] of rows.entries()) {
    if (row.includes("-->")) {
      const [start, end] = row
        .split("-->")
        .map((time) => vttTimeToSeconds(time.trim().split(/\s/)[0]));

      current = { start, end, lines: [] };
      cues.push(current);
      continue;
    }

    // The WEBVTT header, or a cue identifier sitting above its timing row
    if (!current || rows[index + 1]?.includes("-->")) continue;

    // Auto-captions wrap each word in inline timing tags: <00:00:03.520><c> word</c>
    const line = row
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (line) current.lines.push(line);
  }

  return cues.filter((cue) => cue.lines.length);
}

// YouTube's auto-captions scroll: every cue repeats the lines still on screen
// before appending new ones, so only keep a line the first time we see it.
export function transcriptFromCues(cues: Cue[], start: number, end: number) {
  const lines: string[] = [];

  for (const cue of cues) {
    if (cue.end <= start || cue.start >= end) continue;

    for (const line of cue.lines) {
      if (line !== lines.at(-1)) lines.push(line);
    }
  }

  return lines.join("\n");
}
