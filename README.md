# Talk Converter

A powerful CLI tool that helps you split long YouTube videos into individual talk segments, complete with transcripts and AI-generated descriptions.

![Talk Converter Preview](https://github.com/TrystonPerry/talk-converter/blob/main/youtube-converter.png)

## Setup

1. **Prerequisites**

   - Bun (v1.3 or higher)
   - ffmpeg (required for video processing)
   - yt-dlp (required for downloading source videos)
   - AWS Account (for transcription services)
   - Anthropic API Key (for AI-powered summaries)

2. **Installation**

   ```bash
   # Clone the repository
   git clone [repository-url]
   cd talk-converter

   # Install system tools (Arch)
   sudo pacman -S ffmpeg yt-dlp

   # Install dependencies
   bun install
   ```

3. **Environment Variables**
   Copy the `.env.template` file to `.env` and fill in the values:

   ```
   # Anthropic API Key for generating summaries and articles
   ANTHROPIC_API_KEY=your_anthropic_api_key

   # AWS Credentials
   AWS_ACCESS_KEY_ID=your_aws_access_key_id
   AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
   AWS_REGION=us-east-1              # The AWS region for your services
   AWS_S3_BUCKET=your_s3_bucket_name # The S3 bucket for storing audio files and transcripts
   ```

   Make sure your AWS credentials are set up correctly with the following permissions:

   - AmazonS3FullAccess
   - AmazonTranscribeFullAccess

   The S3 bucket should be created in your AWS account and accessible with your credentials.

## How to Use

1. **Basic Usage**

   The `__talks` and `__youtube` folders are created automatically on first run.
   The source video is downloaded via yt-dlp (720p minimum) into
   `__youtube/{YouTube Video ID}.mp4` and reused on subsequent runs, so the
   full video is only fetched once no matter how many talks you slice from it.

   Watch the video through and update the run.sh bash script with a single line for each talk you'd like to process. Script is run once per individual talk to be sliced.

   - `YouTube URL`: Full URL of the YouTube video
   - `timestamps`: Format "start,end" in seconds or HH:MM:SS format
   - `title`: Title for the extracted talk segment

3. **Example**

   ```bash
   npm start -- "https://youtube.com/watch?v=example" "00:15:30,01:45:20" "Understanding AI Systems"
   ```

4. **Output**
   The tool will create:

   - A video file of the extracted segment (`__talks/[title].mp4`)
   - An audio transcript (`__talks/[title].txt`)
   - A markdown file with AI-generated description and article (`__talks/[title].md`)

5. **Processing Steps**
   - Downloads the full YouTube video
   - Extracts the specified segment
   - Generates transcript using AWS Transcribe
   - Creates AI-powered summary and article using Claude

## Notes

- The tool caches downloaded videos and generated transcripts to avoid reprocessing
- Make sure you have sufficient AWS permissions for S3 and Transcribe services
- Video segments are saved in the `__talks` directory
- Original downloaded videos are stored in the `__youtube` directory

