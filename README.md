# Talk Converter

A powerful CLI tool that helps you split long YouTube videos into individual talk segments, complete with transcripts and AI-generated descriptions.

## Setup

1. **Prerequisites**

   - Node.js (v16 or higher)
   - ffmpeg (required for video processing)
   - AWS Account (for transcription services)
   - Anthropic API Key (for AI-powered summaries)

2. **Installation**

   ```bash
   # Clone the repository
   git clone [repository-url]
   cd talk-converter

   # Install dependencies
   npm install
   ```

3. **Environment Variables**
   Copy the `.env.template` file to `.env` and fill in the values:

   ```
   ANTHROPIC_API_KEY=your_anthropic_api_key
   AWS_ACCESS_KEY_ID=your_aws_access_key
   AWS_SECRET_ACCESS_KEY=your_aws_secret_key
   ```

   Make sure your AWS credentials are set up correctly with the following permissions:

   - AmazonS3FullAccess
   - AmazonTranscribeFullAccess

## How to Use

1. **Basic Usage**

   ```bash
   npm start -- [YouTube URL] [timestamps] [title]
   ```

   - `YouTube URL`: Full URL of the YouTube video
   - `timestamps`: Format "start,end" in seconds or HH:MM:SS format
   - `title`: Title for the extracted talk segment

2. **Example**

   ```bash
   npm start -- "https://youtube.com/watch?v=example" "00:15:30,01:45:20" "Understanding AI Systems"
   ```

3. **Output**
   The tool will create:

   - A video file of the extracted segment (`__talks/[title].mp4`)
   - An audio transcript (`__talks/[title].txt`)
   - A markdown file with AI-generated description and article (`__talks/[title].md`)

4. **Processing Steps**
   - Downloads the full YouTube video
   - Extracts the specified segment
   - Generates transcript using AWS Transcribe
   - Creates AI-powered summary and article using Claude

## Notes

- The tool caches downloaded videos and generated transcripts to avoid reprocessing
- Make sure you have sufficient AWS permissions for S3 and Transcribe services
- Video segments are saved in the `__talks` directory
- Original downloaded videos are stored in the `__youtube` directory
