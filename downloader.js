const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const VIDEOS_DIR = path.join(__dirname, "videos");
const SUBTITLES_DIR = path.join(__dirname, "subtitles");
const DESCRIPTIONS_DIR = path.join(__dirname, "descriptions");
const COMMENTS_DIR = path.join(__dirname, "comments");
const TEMP_DOWNLOAD_DIR = path.join(__dirname, "temp_download");
const VIDEO_MAP = path.join(__dirname, "videoMap.csv");

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR);
if (!fs.existsSync(SUBTITLES_DIR)) fs.mkdirSync(SUBTITLES_DIR);
if (!fs.existsSync(DESCRIPTIONS_DIR)) fs.mkdirSync(DESCRIPTIONS_DIR);
if (!fs.existsSync(COMMENTS_DIR)) fs.mkdirSync(COMMENTS_DIR);
if (!fs.existsSync(TEMP_DOWNLOAD_DIR)) fs.mkdirSync(TEMP_DOWNLOAD_DIR);

/**
 * Extracts the YouTube video ID from a URL.
 */
function extractYouTubeId(url) {
	const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
	return match ? match[1] : null;
}

/**
 * Escapes a string for CSV (handles commas, quotes, newlines).
 */
function csvEscape(str) {
	if (!str) return "";
	const s = str.replace(/"/g, '""');
	return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r") ? `"${s}"` : s;
}

/**
 * Formats a YYYYMMDD date string to YYYY-MM-DD.
 */
function formatUploadDate(raw) {
	if (!raw || raw.length !== 8) return raw || "";
	return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/**
 * Reads all available metadata for a given YouTube ID from downloaded files.
 * Extracts: title, description, comment_count, upload_date, view_count, like_count,
 * language, channel, channel_follower_count, channel_is_verified, category, duration.
 * Also stamps the current date as download_date.
 */
function getVideoMetadata(ytId) {
	let title = "";
	let description = "";
	let commentCount = 0;
	let uploadDate = "";
	let viewCount = 0;
	let likeCount = 0;
	let language = "";
	let channel = "";
	let channelFollowerCount = 0;
	let channelIsVerified = false;
	let category = "";
	let duration = "";

	// Extract all metadata from .info.json in comments/
	const infoPath = path.join(COMMENTS_DIR, `${ytId}.info.json`);
	if (fs.existsSync(infoPath)) {
		try {
			const data = JSON.parse(fs.readFileSync(infoPath, "utf8"));
			title = data.title || "";
			description = data.description || "";
			commentCount = data.comment_count || (data.comments ? data.comments.length : 0);
			uploadDate = formatUploadDate(data.upload_date);
			viewCount = data.view_count || 0;
			likeCount = data.like_count || 0;
			language = data.language || "";
			channel = data.channel || data.uploader || "";
			channelFollowerCount = data.channel_follower_count || 0;
			channelIsVerified = data.channel_is_verified || false;
			category = (data.categories && data.categories[0]) || "";
			duration = data.duration_string || "";
		} catch (e) {
			/* ignore */
		}
	}

	// Description from descriptions/ (prefer dedicated file if it exists)
	const descPath = path.join(DESCRIPTIONS_DIR, `${ytId}.description`);
	if (fs.existsSync(descPath)) {
		description = fs.readFileSync(descPath, "utf8").trim();
	}

	// Limit description to 300 chars for CSV readability
	if (description.length > 300) {
		description = description.slice(0, 300);
	}

	// Stamp current date as download date
	const downloadDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

	return {
		title,
		description,
		commentCount,
		uploadDate,
		viewCount,
		likeCount,
		language,
		channel,
		channelFollowerCount,
		channelIsVerified,
		category,
		duration,
		downloadDate,
	};
}

/**
 * Moves downloaded files from temp_download to their corresponding directories.
 */
function distributeDownloadedFiles(ytId) {
	if (fs.existsSync(TEMP_DOWNLOAD_DIR)) {
		const files = fs.readdirSync(TEMP_DOWNLOAD_DIR);
		for (const file of files) {
			if (!file.startsWith(ytId)) continue;
			const srcPath = path.join(TEMP_DOWNLOAD_DIR, file);
			if (file.endsWith(".mp4") || file.endsWith(".mkv") || file.endsWith(".webm")) {
				fs.renameSync(srcPath, path.join(VIDEOS_DIR, file));
			} else if (file.endsWith(".srt")) {
				fs.renameSync(srcPath, path.join(SUBTITLES_DIR, file));
			} else if (file.endsWith(".description") || file.endsWith(".txt")) {
				fs.renameSync(srcPath, path.join(DESCRIPTIONS_DIR, file));
			} else {
				try {
					fs.unlinkSync(srcPath);
				} catch (e) {
					/* ignore */
				}
			}
		}
	}
}

/**
 * Downloads video, subtitles, description, AND comments in one pass.
 */
function downloadAll(url) {
	const ytId = extractYouTubeId(url);
	if (!ytId) {
		console.error(`❌ Could not extract YouTube ID from: ${url}. Skipping.`);
		return null;
	}

	console.log(`\n⬇️  Processing: ${url} (ID: ${ytId})`);

	// --- Stage 1: Video + Subs + Description (downloads to temp folder) ---
	const mediaCmd = `yt-dlp --js-runtimes deno -f "bestvideo[height<=720][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720][ext=mp4][vcodec^=avc1]/best" --write-description --write-auto-subs --write-subs --sub-langs en --convert-subs srt -o "${TEMP_DOWNLOAD_DIR}/%(id)s.%(ext)s" ${url}`;

	try {
		execSync(mediaCmd, { stdio: "inherit" });
		distributeDownloadedFiles(ytId);
		console.log(`✅ Media downloaded and distributed.`);
	} catch (error) {
		console.error(`❌ Media download failed for ${ytId}. Continuing to comments...`);
	}

	// --- Stage 2: Comments ---
	const commentCmd = `yt-dlp --js-runtimes deno --write-comments --skip-download -o "${COMMENTS_DIR}/%(id)s.%(ext)s" ${url}`;

	try {
		execSync(commentCmd, { stdio: "inherit" });
		console.log(`✅ Comments downloaded.`);
	} catch (error) {
		console.error(`❌ Comment download failed for ${ytId}.`);
	}

	return ytId;
}

// --- Main ---
const urlList = fs
	.readFileSync("YouTubeURLs.txt", "utf8")
	.split("\n")
	.map((u) => u.trim())
	.filter((u) => u);

console.log(`🚀 Downloading ${urlList.length} videos (media + comments)...\n`);

// Initialize CSV with header
const CSV_HEADER = [
	"video_id",
	"url",
	"title",
	"upload_date",
	"download_date",
	"view_count",
	"like_count",
	"comment_count",
	"channel",
	"channel_followers",
	"channel_verified",
	"language",
	"category",
	"duration",
	"description",
].join(",");
fs.writeFileSync(VIDEO_MAP, CSV_HEADER + "\n");

for (const url of urlList) {
	const ytId = downloadAll(url);
	if (ytId) {
		const meta = getVideoMetadata(ytId);
		const row = [
			csvEscape(ytId),
			csvEscape(url),
			csvEscape(meta.title),
			meta.uploadDate,
			meta.downloadDate,
			meta.viewCount,
			meta.likeCount,
			meta.commentCount,
			csvEscape(meta.channel),
			meta.channelFollowerCount,
			meta.channelIsVerified,
			meta.language,
			csvEscape(meta.category),
			meta.duration,
			csvEscape(meta.description),
		].join(",");
		fs.appendFileSync(VIDEO_MAP, row + "\n");
		console.log(`📋 Added to videoMap.csv: ${ytId} — ${meta.title} (${meta.channel}, ${meta.viewCount} views)`);
	}
}

console.log(`\n🎉 Done! Videos in /videos, subtitles in /subtitles, descriptions in /descriptions, comments in /comments.`);
console.log(`📋 Video map saved to ${VIDEO_MAP}`);
