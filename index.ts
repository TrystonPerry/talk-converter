import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import {
  formatClock,
  getVideoId,
  parseVtt,
  timeToSeconds,
  timestampedTranscript,
  transcriptFromCues,
} from "./utils";
import { formatBytes, formatDuration, log, timed } from "./logger";

// Aliases rather than pinned IDs, so these track the latest releases.
// Detection reads the whole event transcript and has to reason about where one
// talk ends and the next begins — it runs once per video, so it gets the
// stronger model. Summarising is a per-talk call on a much smaller input.
const DETECTION_MODEL = "sonnet";
const SUMMARY_MODEL = "haiku";

const youtubeDir = path.join(__dirname, "__youtube");
const talksDir = path.join(__dirname, "__talks");

type Talk = {
  speaker: string;
  title: string;
  start: number;
  end: number;
};

// Subprocess output is captured rather than inherited so a failure can report it
// as one labelled block instead of ffmpeg's banner scrolling past on every run.
// `stream` opts back into live output for the download, where the progress bar
// is the only sign of life during a multi-minute fetch.
function run(command: string, { stream = false, quiet = false } = {}) {
  log.debug(`$ ${command}`);

  const startedAt = performance.now();

  try {
    const output = execSync(command, {
      stdio: stream ? "inherit" : "pipe",
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });

    // Echoed through the logger rather than inherited, so --verbose keeps the
    // timestamp prefixes and `run` still gets a return value to hand back.
    if (!quiet && output?.trim()) log.debug(output.trim());

    log.debug(`exit 0 in ${formatDuration(performance.now() - startedAt)}`);

    return output ?? "";
  } catch (error: any) {
    const captured = [error.stdout, error.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();

    if (captured) log.error(captured);

    throw new Error(
      `\`${command.split(" ")[0]}\` failed with exit code ${error.status}`
    );
  }
}

async function fileSize(filePath: string) {
  return formatBytes(Bun.file(filePath).size);
}

function slugify(name: string) {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function ensureInstalled(binary: string, versionCommand: string) {
  try {
    // quiet: the version line is logged below; the full banner is just noise.
    const version = run(versionCommand, { quiet: true }).trim().split("\n")[0];
    log.detail(binary, version || "installed");
  } catch {
    log.error(`${binary} is not installed or not in the system PATH.`);
    process.exit(1);
  }
}

export function checkDependencies() {
  log.info("Checking external tools");
  ensureInstalled("ffmpeg", "ffmpeg -version");
  // Bundled with ffmpeg on most distributions, but not all — checked separately
  // so a split package fails here rather than mid-run on the duration probe.
  ensureInstalled("ffprobe", "ffprobe -version");
  ensureInstalled("yt-dlp", "yt-dlp --version");
  ensureInstalled("claude", "claude --version");
}

export async function makeRelevantDirectories() {
  await fs.mkdir(youtubeDir, { recursive: true });
  await fs.mkdir(talksDir, { recursive: true });

  log.debug(`Working directories ready: ${youtubeDir}, ${talksDir}`);
}

export async function downloadYoutubeVideo(url: string) {
  const videoId = getVideoId(url);

  // Check if the video already exists
  const videoPath = path.join(youtubeDir, `${videoId}.mp4`);
  if (await Bun.file(videoPath).exists()) {
    log.info(`Cached, skipping download: ${videoPath}`);
    log.detail("size", await fileSize(videoPath));

    return videoPath;
  }

  log.info(`Downloading video ${videoId} (720p minimum)`);

  // 720p minimum, muxed into a single mp4 so ffmpeg can seek it
  await timed("download", async () =>
    run(
      `yt-dlp -f "bv[height>=720]+ba/b[height>=720]/bv+ba/b" ` +
        `--merge-output-format mp4 -o ${JSON.stringify(videoPath)} ` +
        `-- ${JSON.stringify(videoId)}`,
      { stream: true }
    )
  );

  log.done(`Downloaded: ${videoPath}`);
  log.detail("size", await fileSize(videoPath));

  return videoPath;
}

function videoDuration(videoPath: string) {
  const output = run(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 ` +
      `${JSON.stringify(videoPath)}`,
    { quiet: true }
  );

  const seconds = Number.parseFloat(output.trim());

  if (!Number.isFinite(seconds)) {
    throw new Error(`Could not read the duration of ${videoPath}`);
  }

  return seconds;
}

// "en.*" can match several tracks (YouTube serves both `en` and `en-orig` for
// English-language videos), so prefer plain `en` and sort the rest for a stable
// pick rather than taking whatever readdir happens to return first.
async function findSubtitleFile(videoId: string) {
  const files = (await fs.readdir(youtubeDir))
    .filter((file) => file.startsWith(`${videoId}.`) && file.endsWith(".vtt"))
    .sort();

  if (files.length > 1) {
    log.debug(`Caption tracks available: ${files.join(", ")}`);
  }

  const match = files.find((file) => file === `${videoId}.en.vtt`) ?? files[0];

  return match ? path.join(youtubeDir, match) : null;
}

export async function downloadYoutubeTranscript(url: string) {
  const videoId = getVideoId(url);

  // Captions cover the whole video, so they're fetched once and sliced per talk
  const cached = await findSubtitleFile(videoId);
  if (cached) {
    log.info(`Cached, skipping fetch: ${cached}`);
    log.detail("size", await fileSize(cached));

    return cached;
  }

  log.info(`Fetching English captions for ${videoId}`);

  await timed("caption fetch", async () =>
    run(
      `yt-dlp --skip-download --write-subs --write-auto-subs ` +
        `--sub-langs "en.*" --convert-subs vtt ` +
        `-o ${JSON.stringify(path.join(youtubeDir, videoId))} ` +
        `-- ${JSON.stringify(videoId)}`
    )
  );

  const subtitlePath = await findSubtitleFile(videoId);
  if (!subtitlePath) {
    throw new Error(
      `No English captions available for ${videoId} — the video may have ` +
        `captions disabled, which this tool depends on.`
    );
  }

  log.done(`Fetched captions: ${subtitlePath}`);
  log.detail("size", await fileSize(subtitlePath));

  return subtitlePath;
}

// The prompt goes in over stdin rather than argv: a full event transcript can
// run past the shell's argument length limit.
async function promptClaude(prompt: string, model: string) {
  log.detail("model", model);
  log.detail("prompt size", formatBytes(Buffer.byteLength(prompt)));

  const proc = Bun.spawn(["claude", "--print", "--model", model], {
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [output, error, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`claude exited with code ${exitCode}: ${error.trim()}`);
  }

  // claude prints warnings to stderr on a successful run too, so they're only
  // worth surfacing, not failing on.
  if (error.trim()) log.warn(error.trim());

  return output.trim();
}

// Asking for bare JSON is not a guarantee of getting it — the model may wrap the
// array in a code fence or lead with a sentence, so dig the array out rather
// than handing the whole reply to JSON.parse.
function parseTalksJson(raw: string): unknown[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();

  const open = candidate.indexOf("[");
  const close = candidate.lastIndexOf("]");

  if (open === -1 || close <= open) {
    throw new Error(
      `Talk detection did not return a JSON array. Response began: ` +
        `${raw.slice(0, 200)}`
    );
  }

  const parsed = JSON.parse(candidate.slice(open, close + 1));

  if (!Array.isArray(parsed)) throw new Error("Talk detection returned non-array JSON");

  return parsed;
}

// The model is guessing boundaries from misspelt auto-captions, so every field
// is treated as untrusted: bad entries are dropped with a reason rather than
// being allowed to drive an ffmpeg cut.
function validateTalks(entries: unknown[], duration: number): Talk[] {
  const talks: Talk[] = [];

  for (const [index, entry] of entries.entries()) {
    const label = `talk ${index + 1}`;
    const record = entry as Record<string, unknown>;

    if (!record || typeof record !== "object") {
      log.warn(`Skipping ${label}: not an object`);
      continue;
    }

    const speaker = String(record["speaker"] ?? "").trim();
    const title = String(record["title"] ?? "").trim();

    let start: number;
    let end: number;

    try {
      start = timeToSeconds(String(record["start"]));
      end = timeToSeconds(String(record["end"]));
    } catch {
      log.warn(
        `Skipping ${label} (${title || "untitled"}): unreadable timestamps ` +
          `${JSON.stringify(record["start"])}–${JSON.stringify(record["end"])}`
      );
      continue;
    }

    if (!title && !speaker) {
      log.warn(`Skipping ${label}: no speaker or title`);
      continue;
    }

    if (!(end > start)) {
      log.warn(
        `Skipping ${label} (${title || speaker}): end ${formatClock(end)} is ` +
          `not after start ${formatClock(start)}`
      );
      continue;
    }

    if (start >= duration) {
      log.warn(
        `Skipping ${label} (${title || speaker}): starts at ` +
          `${formatClock(start)}, past the ${formatClock(duration)} runtime`
      );
      continue;
    }

    // A hallucinated end past the runtime is recoverable — clamp it rather than
    // throwing away an otherwise good talk.
    if (end > duration) {
      log.warn(
        `Clamping ${label} (${title || speaker}) end from ${formatClock(end)} ` +
          `to the ${formatClock(duration)} runtime`
      );
      end = duration;
    }

    const previous = talks.at(-1);
    if (previous && start < previous.end) {
      log.warn(
        `${title || speaker} starts at ${formatClock(start)}, before the ` +
          `previous talk ends at ${formatClock(previous.end)} — segments will overlap`
      );
    }

    talks.push({ speaker, title, start, end });
  }

  return talks;
}

export async function detectTalks(subtitlePath: string, duration: number) {
  const cues = parseVtt(await fs.readFile(subtitlePath, "utf8"));
  const transcript = timestampedTranscript(cues);

  log.detail("cues parsed", cues.length);
  log.detail("runtime", formatClock(duration));

  const output = await timed("detection", async () =>
    promptClaude(
      `Below is the auto-generated caption transcript of a recorded event ` +
        `containing several talks. Every line is prefixed with the timestamp at ` +
        `which it was said.\n\n` +
        `Identify each individual talk. A talk typically begins when an MC ` +
        `introduces the speaker ("welcome to the stage", "please welcome") or ` +
        `the speaker introduces themselves ("hi, I'm ..."), and ends once their ` +
        `Q&A is finished or they sign off ("and that's my talk", "thank you").\n\n` +
        `Opening remarks, housekeeping, sponsor messages and breaks are not ` +
        `talks — leave them out.\n\n` +
        `The captions are auto-generated, so names and technical terms may be ` +
        `misspelt. Use your best guess at the correct spelling.\n\n` +
        `Respond with ONLY a JSON array and no other text:\n` +
        `[{"speaker":"Full Name","title":"Talk title","start":"H:MM:SS","end":"H:MM:SS"}]\n\n` +
        `- "start" is where the introduction to the talk begins.\n` +
        `- "end" is after the Q&A concludes.\n` +
        `- If a talk has no stated title, describe its topic in a few words.\n` +
        `- The recording is ${formatClock(duration)} long; no timestamp may exceed that.\n` +
        `- If there are no talks at all, return [].\n\n` +
        `Transcript:\n\n${transcript}`,
      DETECTION_MODEL
    )
  );

  const talks = validateTalks(parseTalksJson(output), duration);

  if (talks.length === 0) {
    throw new Error(
      "No talks were identified in this recording. Re-run with --verbose to " +
        "see the model's response, or pass explicit timestamps and a title."
    );
  }

  log.done(`Identified ${talks.length} talk${talks.length === 1 ? "" : "s"}`);

  for (const [index, talk] of talks.entries()) {
    log.detail(
      `${index + 1}. ${talk.title}`,
      `${talk.speaker || "unknown speaker"} · ${formatClock(talk.start)}–` +
        `${formatClock(talk.end)} (${formatDuration((talk.end - talk.start) * 1000)})`
    );
  }

  return talks;
}

export async function spliceVideoIntoSegments(
  talkPath: string,
  start: number,
  end: number,
  videoPath: string
) {
  const segmentPath = `${talkPath}.mp4`;

  if (await Bun.file(segmentPath).exists()) {
    log.info(`Cached, skipping extract: ${segmentPath}`);
    log.detail("size", await fileSize(segmentPath));

    return;
  }

  log.info(
    `Cutting ${formatClock(start)}–${formatClock(end)} ` +
      `(${formatDuration((end - start) * 1000)}) from the source video`
  );

  // Extract the talk segment from the video
  await timed("extract", async () =>
    run(
      `ffmpeg -i ${JSON.stringify(videoPath)} -ss ${start} -to ${end} ` +
        `-c copy ${JSON.stringify(segmentPath)}`
    )
  );

  log.done(`Wrote segment: ${segmentPath}`);
  log.detail("size", await fileSize(segmentPath));
}

export async function generateTranscript(
  subtitlePath: string,
  talkPath: string,
  start: number,
  end: number
) {
  const transcriptFile = `${talkPath}.txt`;

  if (await Bun.file(transcriptFile).exists()) {
    log.info(`Cached, skipping slice: ${transcriptFile}`);
    log.detail("size", await fileSize(transcriptFile));

    return;
  }

  const cues = parseVtt(await fs.readFile(subtitlePath, "utf8"));
  const transcript = transcriptFromCues(cues, start, end);

  if (!transcript) {
    throw new Error(
      `No captions found between ${formatClock(start)} and ${formatClock(end)}`
    );
  }

  await fs.writeFile(transcriptFile, transcript);

  log.done(`Wrote transcript: ${transcriptFile}`);
  log.detail("lines", transcript.split("\n").length);
  log.detail("characters", transcript.length);
}

export async function generateSummary(talkPath: string, talk: Talk) {
  const summaryPath = `${talkPath}.md`;

  if (await Bun.file(summaryPath).exists()) {
    log.info(`Cached, skipping summary: ${summaryPath}`);
    log.detail("size", await fileSize(summaryPath));

    return;
  }

  const transcript = await fs.readFile(`${talkPath}.txt`, "utf8");

  const output = await timed("summary", async () =>
    promptClaude(
      `Below is the transcript of a conference talk` +
        (talk.speaker ? ` by ${talk.speaker}` : "") +
        (talk.title ? `, titled "${talk.title}"` : "") +
        `. It comes from auto-generated captions, so punctuation and the ` +
        `occasional word may be wrong, and it may begin or end mid-sentence.\n\n` +
        `Work with the transcript as given — do not ask for a fuller one.\n\n` +
        `${transcript}\n\n` +
        `Write the two sections below in markdown, with no preamble:\n\n` +
        `## Description\nA summary of the talk, for use as a video description.\n\n` +
        `## Article\nAn article covering the talk's content, including the Q&A ` +
        `if the transcript contains one.`,
      SUMMARY_MODEL
    )
  );

  // Without this the model can answer with a clarifying question instead of the
  // article, and an unattended run would report success over a useless file.
  if (!output.includes("## Description") || !output.includes("## Article")) {
    throw new Error(
      `Summary for "${talk.title}" is missing its Description/Article ` +
        `sections. Response began: ${output.slice(0, 200)}`
    );
  }

  await fs.writeFile(
    summaryPath,
    `# ${talk.title || path.basename(talkPath)}\n\n` +
      (talk.speaker ? `_${talk.speaker}_\n\n` : "") +
      `${output}\n`
  );

  log.done(`Wrote summary: ${summaryPath}`);
  log.detail("size", await fileSize(summaryPath));
}

async function processTalk(
  talk: Talk,
  videoPath: string,
  subtitlePath: string
) {
  const name = slugify(
    [talk.speaker, talk.title].filter(Boolean).join(" - ")
  );
  const talkPath = path.join(talksDir, name);

  await spliceVideoIntoSegments(talkPath, talk.start, talk.end, videoPath);
  await generateTranscript(subtitlePath, talkPath, talk.start, talk.end);
  await generateSummary(talkPath, talk);

  return talkPath;
}

function usage() {
  log.error("Usage: npm start -- [YouTube URL] [options]");
  log.error("");
  log.error("  --list                 detect talks and print them, without slicing");
  log.error("  --verbose              show commands, exit codes and full output");
  log.error("  --range start,end      skip detection and cut one segment");
  log.error("  --title 'Talk title'   name for --range (required with it)");
  log.error("");
  log.error("Example: npm start -- https://youtube.com/watch?v=example");

  process.exit(1);
}

function flagValue(name: string) {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const flags = new Set(
    process.argv.slice(2).filter((arg) => arg.startsWith("--"))
  );
  const range = flagValue("range");
  const title = flagValue("title");

  // Flag values are dropped alongside the flags so they can sit anywhere.
  const positional = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--") && arg !== range && arg !== title);

  const [url] = positional;

  if (!url) usage();
  if (range && !title) {
    log.error("--range requires --title");
    usage();
  }

  const startedAt = performance.now();

  try {
    log.info(`Source: ${url}`);
    log.detail("video id", getVideoId(url));

    checkDependencies();
    await makeRelevantDirectories();

    // Reuses the cached file if the video was already fetched
    log.step("1/3", "Reading YouTube video");
    const videoPath = await downloadYoutubeVideo(url);
    const duration = videoDuration(videoPath);
    log.detail("runtime", formatClock(duration));

    log.step("2/3", "Reading YouTube captions");
    const subtitlePath = await downloadYoutubeTranscript(url);

    let talks: Talk[];

    if (range) {
      const [start, end] = range.split(",").map(timeToSeconds);

      if (start === undefined || end === undefined || !(end > start)) {
        throw new Error(
          `Invalid --range "${range}" — expected "start,end" with end after start.`
        );
      }

      log.step("3/3", "Using the range given, skipping detection");
      talks = validateTalks(
        [{ speaker: "", title, start: formatClock(start), end: formatClock(end) }],
        duration
      );
    } else {
      log.step("3/3", "Identifying talks");
      talks = await detectTalks(subtitlePath, duration);
    }

    if (flags.has("--list")) {
      console.log("");
      log.done("Detection only (--list), nothing was sliced.");

      return;
    }

    const produced: string[] = [];

    for (const [index, talk] of talks.entries()) {
      log.step(
        `Talk ${index + 1}/${talks.length}`,
        `${talk.title}${talk.speaker ? ` — ${talk.speaker}` : ""}`
      );

      // One bad talk shouldn't cost the whole batch — the rest still run, and
      // the failure is reported in the summary at the end.
      try {
        produced.push(await processTalk(talk, videoPath, subtitlePath));
      } catch (error: any) {
        log.error(`Talk ${index + 1} failed: ${error.message}`);
      }
    }

    console.log("");

    if (produced.length < talks.length) {
      log.warn(
        `${talks.length - produced.length} of ${talks.length} talks failed — ` +
          `see the errors above.`
      );
    }

    log.done(
      `Completed ${produced.length}/${talks.length} in ` +
        `${formatDuration(performance.now() - startedAt)} 🎉`
    );

    for (const talkPath of produced) {
      log.detail(path.basename(talkPath), "mp4 · txt · md");
    }

    if (produced.length < talks.length) process.exit(1);
  } catch (error: any) {
    console.log("");
    log.error(error.message);

    // The stack is noise for the expected failures (missing captions, bad
    // timestamps) but the first thing you want for anything else.
    if (log.verbose && error.stack) log.debug(error.stack);
    else log.info("Re-run with --verbose for the full command output.");

    process.exit(1);
  }
}

// Run the main function
main().catch((error: Error) => {
  log.error(`Unhandled failure: ${error.stack ?? error.message}`);
  process.exit(1);
});
