import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import {
  getVideoId,
  parseVtt,
  timeToSeconds,
  transcriptFromCues,
} from "./utils";

const client = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"], // This is the default and can be omitted
});

// Undated alias, so this tracks the latest Haiku release without a code change.
const MODEL = "claude-haiku-4-5";

const youtubeDir = path.join(__dirname, "__youtube");
const talksDir = path.join(__dirname, "__talks");

export function ensureFfmpegInstalled() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
  } catch (error) {
    console.error("Error: ffmpeg is not installed or not in the system PATH.");
    process.exit(1);
  }

  console.log("ffmpeg is installed");
}

export function ensureYtDlpInstalled() {
  try {
    execSync("yt-dlp --version", { stdio: "ignore" });
  } catch (error) {
    console.error("Error: yt-dlp is not installed or not in the system PATH.");
    process.exit(1);
  }

  console.log("yt-dlp is installed");
}

export async function makeRelevantDirectories() {
  await fs.mkdir(youtubeDir, { recursive: true });
  await fs.mkdir(talksDir, { recursive: true });

  console.log("Relevant directories created");
}

export async function downloadYoutubeVideo(url: string) {
  const videoId = getVideoId(url);

  // Check if the video already exists
  const videoPath = path.join(youtubeDir, `${videoId}.mp4`);
  if (await Bun.file(videoPath).exists()) {
    console.log(`Youtube video found: ${videoPath}`);
  } else {
    // 720p minimum, muxed into a single mp4 so ffmpeg can seek it
    console.log("Starting YouTube video download...");
    execSync(
      `yt-dlp -f "bv[height>=720]+ba/b[height>=720]/bv+ba/b" ` +
        `--merge-output-format mp4 -o ${JSON.stringify(videoPath)} ` +
        `-- ${JSON.stringify(videoId)}`,
      { stdio: "inherit" }
    );

    console.log(`Youtube video downloaded: ${videoPath}`);
  }

  return videoPath;
}

// "en.*" can match several tracks (YouTube serves both `en` and `en-orig` for
// English-language videos), so prefer plain `en` and sort the rest for a stable
// pick rather than taking whatever readdir happens to return first.
async function findSubtitleFile(videoId: string) {
  const files = (await fs.readdir(youtubeDir))
    .filter((file) => file.startsWith(`${videoId}.`) && file.endsWith(".vtt"))
    .sort();

  const match = files.find((file) => file === `${videoId}.en.vtt`) ?? files[0];

  return match ? path.join(youtubeDir, match) : null;
}

export async function downloadYoutubeTranscript(url: string) {
  const videoId = getVideoId(url);

  // Captions cover the whole video, so they're fetched once and sliced per talk
  const cached = await findSubtitleFile(videoId);
  if (cached) {
    console.log(`Youtube captions found: ${cached}`);
    return cached;
  }

  console.log("Fetching YouTube captions...");
  execSync(
    `yt-dlp --skip-download --write-subs --write-auto-subs ` +
      `--sub-langs "en.*" --convert-subs vtt ` +
      `-o ${JSON.stringify(path.join(youtubeDir, videoId))} ` +
      `-- ${JSON.stringify(videoId)}`,
    { stdio: "inherit" }
  );

  const subtitlePath = await findSubtitleFile(videoId);
  if (!subtitlePath) {
    throw new Error(`No English captions available for ${videoId}`);
  }

  console.log(`Youtube captions downloaded: ${subtitlePath}`);
  return subtitlePath;
}

export async function spliceVideoIntoSegments(
  title: string,
  start: number,
  end: number,
  videoPath: string
) {
  console.log(`Splitting video from ${start}s to ${end}s`);

  const talkPath = path.join(talksDir, title.replace(/[^a-zA-Z0-9]/g, "_"));

  // Extract the talk segment from the video
  if (!(await Bun.file(`${talkPath}.mp4`).exists())) {
    execSync(
      `ffmpeg -i ${videoPath} -ss ${start} -to ${end} -c copy ${talkPath}.mp4`,
      {
        stdio: "inherit",
      }
    );
  }

  return talkPath;
}

export async function generateTranscript(
  subtitlePath: string,
  talkPath: string,
  start: number,
  end: number
) {
  const transcriptFile = `${talkPath}.txt`;

  if (await Bun.file(transcriptFile).exists()) {
    console.log(`Transcript found: ${transcriptFile}`);
    return;
  }

  const cues = parseVtt(await fs.readFile(subtitlePath, "utf8"));
  const transcript = transcriptFromCues(cues, start, end);

  if (!transcript) {
    throw new Error(`No captions found between ${start}s and ${end}s`);
  }

  await fs.writeFile(transcriptFile, transcript);
  console.log(`Generated transcript: ${transcriptFile}`);
}

// Collect every text block rather than indexing content[0], in case the
// response leads with a non-text block.
async function promptClaude(prompt: string) {
  const message = await client.messages.create({
    max_tokens: 16000,
    messages: [{ role: "user", content: prompt }],
    model: MODEL,
  });

  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined the request");
  }

  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function generateSummary(talkPath: string) {
  const transcript = await fs.readFile(`${talkPath}.txt`, "utf8");

  const output = await promptClaude(
    `Here is the transcript of a conference talk. It comes from ` +
      `auto-generated captions, so punctuation and the occasional word may be wrong:\n\n` +
      `${transcript}\n\n` +
      `Write the two sections below in markdown, with no preamble:\n\n` +
      `## Description\nA summary of the talk, for use as a video description.\n\n` +
      `## Article\nAn article covering the talk's content, including the Q&A at the end.`
  );

  const summaryPath = `${talkPath}.md`;
  await fs.writeFile(summaryPath, `# ${path.basename(talkPath)}\n\n${output}\n`);

  console.log(`Generated summary: ${summaryPath}`);
}

async function main() {
  // Get command line arguments
  const [url, timestamps, title] = process.argv.slice(2);

  if (!url || !timestamps || !title) {
    console.error("Usage: npm start -- [YouTube URL] [timestamps] [title]");
    console.error(
      "Example: npm start -- https://youtube.com/watch?v=example 00:15:30,01:45:20 'Understanding AI Systems'"
    );
    process.exit(1);
  }

  try {
    // Ensure external tools are installed
    ensureFfmpegInstalled();
    ensureYtDlpInstalled();

    // Create necessary directories
    await makeRelevantDirectories();

    const [start, end] = timestamps.split(",").map(timeToSeconds);

    // Download the YouTube video (reuses the cached file if already present)
    console.log("\n1. Reading YouTube video...");
    const videoPath = await downloadYoutubeVideo(url);

    console.log("\n2. Reading YouTube captions...");
    const subtitlePath = await downloadYoutubeTranscript(url);

    console.log("\n3. Extracting talk segment...");
    const talkPath = await spliceVideoIntoSegments(
      title,
      start,
      end,
      videoPath
    );

    // Slice the whole-video captions down to this talk
    console.log("\n4. Generating transcript...");
    await generateTranscript(subtitlePath, talkPath, start, end);

    // Generate summary and article
    console.log("\n5. Generating AI summary and article...");
    await generateSummary(talkPath);

    console.log("\nProcess completed successfully! 🎉");
    console.log(
      `Output files are in: ${talksDir}/${title.replace(
        /[^a-zA-Z0-9]/g,
        "_"
      )}.*`
    );
  } catch (error: any) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Run the main function
main().catch((error: Error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
