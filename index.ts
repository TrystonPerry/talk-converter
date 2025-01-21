import { execSync } from "child_process";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import ytdl from "ytdl-core";
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from "@aws-sdk/client-transcribe";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import Anthropic from "@anthropic-ai/sdk";
import { timeToSeconds } from "./utils";

const client = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"], // This is the default and can be omitted
});

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

export async function makeRelevantDirectories() {
  await fs.mkdir(youtubeDir, { recursive: true });
  await fs.mkdir(talksDir, { recursive: true });

  console.log("Relevant directories created");
}

export async function downloadYoutubeVideo(url: string) {
  // Validate the YouTube URL
  if (!ytdl.validateURL(url)) {
    console.error("Invalid YouTube URL");
    process.exit(1);
  }

  // Extract the video ID from the URL
  const videoId = ytdl.getURLVideoID(url);

  // Check if the video already exists
  const videoPath = path.join(youtubeDir, `${videoId}.mp4`);
  if (await fs.exists(videoPath)) {
    console.log(`Youtube video found: ${videoPath}`);
  } else {
    // Download Youtube video
    console.log("Starting YouTube video download...");
    await new Promise((resolve, reject) => {
      const stream = ytdl(url, {
        quality: "highest",
        filter: "audioandvideo",
      });

      let downloadedBytes = 0;

      stream.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        process.stdout.write(
          `Download progress: ${Math.round(downloadedBytes / 1024 / 1024)}MB\r`
        );
      });

      stream.on("error", (err) => reject(err));

      stream
        .pipe(createWriteStream(videoPath))
        .on("finish", resolve)
        .on("error", (err) => reject(err));
    });
    console.log("Download complete");

    console.log(`Youtube video downloaded: ${videoPath}`);
  }

  return videoPath;
}

export async function spliceVideoIntoSegments(
  title: string,
  timestamps: string,
  videoPath: string
) {
  const [start, end] = timestamps.split(",").map(timeToSeconds);

  console.log(`Splitting video from ${start}s to ${end}s`);

  const talkPath = path.join(talksDir, title.replace(/[^a-zA-Z0-9]/g, "_"));

  // Extract the talk segment from the video
  if (!(await fs.exists(`${talkPath}.mp4`))) {
    execSync(
      `ffmpeg -i ${videoPath} -ss ${start} -to ${end} -c copy ${talkPath}.mp4`,
      {
        stdio: "inherit",
      }
    );
  }

  // Get the audio transcript from the talk segment
  if (!(await fs.exists(`${talkPath}.mp3`))) {
    execSync(
      `ffmpeg -i ${talkPath}.mp4 -vn -ab 320k -ar 44100 -y ${talkPath}.mp3`,
      {
        stdio: "inherit",
      }
    );
  }

  return talkPath;
}

export async function generateTranscript(talkPath: string) {
  const audioFile = `${talkPath}.mp3`;
  const transcriptFile = `${talkPath}.txt`;
  console.log(`Generating transcript for ${audioFile}`);

  // Check if the transcript already exists
  if (await fs.exists(transcriptFile)) {
    console.log(`Transcript found: ${transcriptFile}`);
  } else {
    // Initialize the Transcribe and S3 clients
    const region = process.env["AWS_REGION"];
    const transcribeClient = new TranscribeClient({ region });
    const s3Client = new S3Client({ region });

    // Upload the audio file to S3
    const bucketName = process.env["AWS_S3_BUCKET"]; // Replace with your S3 bucket name

    // Read the audio file as binary
    const audioFileContents = await fs.readFile(audioFile);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: `audio/${audioFile}`,
        Body: audioFileContents,
      })
    );

    // Start the transcription job
    const jobName = `transcription-job-${Date.now()}`;
    await transcribeClient.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        LanguageCode: "en-US", // Adjust based on the language of your audio
        MediaFormat: "mp3",
        Media: {
          MediaFileUri: `s3://${bucketName}/audio/${audioFile}`,
        },
        OutputBucketName: bucketName,
      })
    );

    // Wait for the transcription job to complete
    let transcriptionJob;
    do {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait for 5 seconds before checking again
      const response = await transcribeClient.send(
        new GetTranscriptionJobCommand({
          TranscriptionJobName: jobName,
        })
      );
      transcriptionJob = response.TranscriptionJob;
    } while (transcriptionJob?.TranscriptionJobStatus === "IN_PROGRESS");

    if (transcriptionJob?.TranscriptionJobStatus !== "COMPLETED") {
      throw new Error("Transcription job failed");
    }

    // Fetch the transcript
    const transcriptUrl = transcriptionJob?.Transcript
      ?.TranscriptFileUri as string;
    const transcriptResponse = await fetch(transcriptUrl);
    const transcriptData = await transcriptResponse.json();

    console.log(`Generated transcript`);

    const transcript = transcriptData.results.transcripts[0].transcript;
    await fs.writeFile(transcriptFile, transcript);
  }
}

export async function generateSummary(talkPath: string) {
  const transcriptFile = `${talkPath}.txt`;
  const transcript = await fs.readFile(transcriptFile, "utf8");

  let description = "";
  let article = "";

  {
    const message = await client.messages.create({
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `
        given this transcript from an audio file (with possible parts missing)
  
        ${transcript}
  
        generate a summary of the talk for video description purposes
        `,
        },
      ],
      model: "claude-3-opus-20240229",
    });

    if (message.content[0].type === "text") {
      description = message.content[0].text;
    }
  }

  {
    const message = await client.messages.create({
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `
      given this transcript from an audio file (with possible parts missing)

      ${transcript}

      give me an article from this content. along with the q&a section at the end
      `,
        },
      ],
      model: "claude-3-opus-20240229",
    });

    if (message.content[0].type === "text") {
      article = message.content[0].text;
    }
  }

  const summaryPath = `${talkPath}.md`;
  await fs.writeFile(
    summaryPath,
    `# ${path.basename(talkPath)}

    ## Description
    ${description}

    ## Article
    ${article}
    `
  );

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
    // Ensure ffmpeg is installed
    ensureFfmpegInstalled();

    // Create necessary directories
    await makeRelevantDirectories();

    // Download the YouTube video
    console.log("\n1. Reading YouTube video...");
    const videoId = ytdl.getURLVideoID(url);
    const videoPath = path.join(youtubeDir, `${videoId}.mp4`);

    console.log("\n2. Extracting talk segment...");
    const talkPath = await spliceVideoIntoSegments(
      title,
      timestamps,
      videoPath
    );

    // Generate transcript
    console.log("\n3. Generating transcript...");
    await generateTranscript(talkPath);

    // Generate summary and article
    console.log("\n4. Generating AI summary and article...");
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
