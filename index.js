const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { extractFrames } = require("./extractor");
const { scoreVideoAesthetics } = require("./scorer");
const { scoreExpectationFormation } = require("./efScorer");
const { parseComments, buildCommentIndex, formatCommentsForPrompt, chunkComments } = require("./commentParser");
const { scoreComments, aggregateChunkResults } = require("./commentScorer");
const { analyzeConflict } = require("./merger");

const VIDEOS_DIR = path.join(__dirname, "videos");
const SUBTITLES_DIR = path.join(__dirname, "subtitles");
const DESCRIPTIONS_DIR = path.join(__dirname, "descriptions");
const TEMP_FRAMES_DIR = path.join(__dirname, "temp_frames");
const COMMENTS_DIR = path.join(__dirname, "comments");
const OUTPUT_FILE = path.join(__dirname, "rideScores.json");
const CSV_OUTPUT_FILE = path.join(__dirname, "rideScores.csv");
const TRACKER_FILE = path.join(__dirname, "tracker.csv");
const VIDEO_MAP = path.join(__dirname, "videoMap.csv");

/**
 * Escapes values for CSV serialization.
 */
function csvEscape(val) {
	if (val === null || val === undefined) return "";
	const str = String(val);
	const s = str.replace(/"/g, '""');
	return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r") ? `"${s}"` : s;
}

/**
 * Gets the detailed processing status for a video.
 */
function getTrackerState(videoId, videoFiles, commentIndex, scoresMap) {
	const videoExists = videoFiles.some((f) => {
		const name = path.parse(f).name;
		return name === videoId;
	});
	const videoDownloaded = videoExists ? "true" : "false";

	const commentsDownloaded = commentIndex.has(videoId) ? "true" : "false";

	let transcriptDownloaded = "false";
	if (fs.existsSync(SUBTITLES_DIR)) {
		const srts = fs.readdirSync(SUBTITLES_DIR).filter((f) => f.startsWith(videoId) && f.endsWith(".srt"));
		if (srts.length > 0) transcriptDownloaded = "true";
	}

	const tempDir = path.join(TEMP_FRAMES_DIR, videoId);
	let framesExtracted = "false";
	if (fs.existsSync(tempDir)) {
		const files = fs.readdirSync(tempDir);
		const hasJpegs = files.some((f) => f.endsWith(".jpg") || f.endsWith(".jpeg"));
		if (hasJpegs) framesExtracted = "true";
	}

	const entry = scoresMap.get(videoId);
	const framesProcessed = entry && entry.scores != null ? "true" : "false";
	const efProcessed = entry && entry.expectationFormation != null ? "true" : "false";
	const commentsProcessed = entry && entry.commentAnalysis != null ? "true" : "false";
	const conflictProcessed = entry && entry.conflictAnalysis != null ? "true" : "false";
	const finalDatasetGenerated =
		framesProcessed === "true" && efProcessed === "true" && commentsProcessed === "true" && conflictProcessed === "true" ? "true" : "false";

	return {
		videoId,
		videoDownloaded,
		commentsDownloaded,
		transcriptDownloaded,
		framesExtracted,
		framesProcessed,
		efProcessed,
		commentsProcessed,
		conflictProcessed,
		finalDatasetGenerated,
	};
}

/**
 * Regenerates the tracker.csv file.
 */
function saveTracker(videoFiles, commentIndex, scoresMap) {
	const trackerRows = videoFiles.map((videoFile) => {
		const videoId = path.parse(videoFile).name;
		const state = getTrackerState(videoId, videoFiles, commentIndex, scoresMap);
		return [
			state.videoId,
			state.videoDownloaded,
			state.commentsDownloaded,
			state.transcriptDownloaded,
			state.framesExtracted,
			state.framesProcessed,
			state.efProcessed,
			state.commentsProcessed,
			state.conflictProcessed,
			state.finalDatasetGenerated,
		].join(",");
	});

	const header =
		"video_id,video_downloaded,comments_downloaded,transcript_downloaded,frames_extracted,frames_processed,ef_processed,comments_processed,conflict_processed,final_dataset_generated";
	const csvContent = [header, ...trackerRows].join("\n") + "\n";
	fs.writeFileSync(TRACKER_FILE, csvContent);
}

/**
 * Gets companion files (SRT, description) for a given YouTube ID.
 */
function getMediaAssets(videoId) {
	let srtPath = null;
	let descPath = null;

	if (fs.existsSync(SUBTITLES_DIR)) {
		const srts = fs.readdirSync(SUBTITLES_DIR).filter((f) => f.startsWith(videoId) && f.endsWith(".srt"));
		const bestSrt = srts.find((f) => !f.includes("ASR")) || srts[0];
		if (bestSrt) srtPath = path.join(SUBTITLES_DIR, bestSrt);
	}

	const descFile = path.join(DESCRIPTIONS_DIR, `${videoId}.description`);
	if (fs.existsSync(descFile)) {
		descPath = descFile;
	}

	return {
		srtPath,
		descPath,
	};
}

/**
 * Loads rideScores.json as Map<videoId, entry>.
 */
function loadExistingScores() {
	const scoresMap = new Map();
	if (!fs.existsSync(OUTPUT_FILE)) return scoresMap;

	try {
		const raw = fs.readFileSync(OUTPUT_FILE, "utf8").trim();
		const entries = JSON.parse(raw);
		if (Array.isArray(entries)) {
			for (const entry of entries) {
				if (entry.videoId) scoresMap.set(entry.videoId, entry);
			}
		}
	} catch (e) {
		console.warn(`⚠️ Could not parse ${OUTPUT_FILE}: ${e.message}. Starting fresh.`);
	}
	return scoresMap;
}

/**
 * Saves scores map to rideScores.json as JSON and rideScores.csv as CSV.
 */
function saveScores(scoresMap) {
	const arr = Array.from(scoresMap.values());
	// Save JSON
	fs.writeFileSync(OUTPUT_FILE, JSON.stringify(arr, null, 2) + "\n");

	// Save CSV
	const csvHeaders = [
		"videoId",
		"icAuthenticity",
		"icEscape",
		"icTransformation",
		"icHedonic",
		"icWellness",
		"icLuxury",
		"icRationale",
		"efFriendlyLocals",
		"efPeacefulAtmosphere",
		"efAffordability",
		"efAuthenticity",
		"efExcitement",
		"efFreedom",
		"efSafety",
		"efCommunity",
		"efSimplicity",
		"efTransformation",
		"efRationale",
		"commentCount",
		"dcHedonic",
		"dcNormative",
		"caConflict",
		"caAdaptation",
		"sentimentPolarity",
		"sentimentIntensity",
		"quoteDisconfirmation",
		"quoteConflict",
		"quoteAdaptation",
		"commentRationale",
		"hasConflict",
		"conflictIntensity",
		"conflictRationale",
	].join(",");

	const csvRows = arr.map((entry) => {
		const s = entry.scores || {};
		const ef = entry.expectationFormation || {};
		const ca = entry.commentAnalysis || {};
		const dc = ca.disconfirmation || {};
		const co = ca.conflictAdaptation || {};
		const se = ca.sentiment || {};
		const qu = ca.representativeQuotes || {};
		const intensity = se.emotionalIntensity ?? se.emotional_intensity ?? "";

		return [
			entry.videoId || "",
			s.authenticity ?? "",
			s.escape ?? "",
			s.transformation ?? "",
			s.hedonic ?? "",
			s.wellness ?? "",
			s.luxury ?? "",
			entry.rationale || "",
			ef.friendlyLocals ?? "",
			ef.peacefulAtmosphere ?? "",
			ef.affordability ?? "",
			ef.authenticity ?? "",
			ef.excitement ?? "",
			ef.freedom ?? "",
			ef.safety ?? "",
			ef.community ?? "",
			ef.simplicity ?? "",
			ef.transformation ?? "",
			ef.rationale || "",
			ca.commentCount ?? "",
			dc.hedonic ?? "",
			dc.normative ?? "",
			co.conflict ?? "",
			co.adaptation ?? "",
			se.polarity || "",
			intensity,
			qu.disconfirmation || "",
			qu.conflict || "",
			qu.adaptation || "",
			ca.rationale || "",
			entry.conflictAnalysis?.hasConflict ?? "",
			entry.conflictAnalysis?.conflictIntensity ?? "",
			entry.conflictAnalysis?.rationale || "",
		]
			.map(csvEscape)
			.join(",");
	});

	const csvContent = [csvHeaders, ...csvRows].join("\n") + "\n";
	fs.writeFileSync(CSV_OUTPUT_FILE, csvContent);
}

function formatUploadDate(raw) {
	if (!raw || raw.length !== 8) return raw || "";
	return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function ensureDownloads() {
	if (!fs.existsSync("YouTubeURLs.txt")) return;

	// Ensure all base directories exist before checking/downloading
	[VIDEOS_DIR, SUBTITLES_DIR, DESCRIPTIONS_DIR, TEMP_FRAMES_DIR, COMMENTS_DIR].forEach((dir) => {
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	});

	const urlList = fs
		.readFileSync("YouTubeURLs.txt", "utf8")
		.split("\n")
		.map((u) => u.trim())
		.filter(Boolean);

	let hasHeader = false;
	if (fs.existsSync(VIDEO_MAP)) {
		hasHeader = fs.readFileSync(VIDEO_MAP, "utf8").includes("video_id");
	}

	if (!hasHeader) {
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
	}

	for (const url of urlList) {
		const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
		const ytId = match ? match[1] : null;
		if (!ytId) continue;

		// Check if downloaded
		const videoExists = fs.readdirSync(VIDEOS_DIR).some((f) => f.startsWith(ytId));
		const commentExists = fs.existsSync(path.join(COMMENTS_DIR, `${ytId}.info.json`));

		if (videoExists && commentExists) {
			continue;
		}

		console.log(`\n⬇️  Downloading missing files for: ${url} (ID: ${ytId})`);

		if (!videoExists) {
			const mediaCmd = `yt-dlp --js-runtimes deno -f "bestvideo[height<=720][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720][ext=mp4][vcodec^=avc1]/best" --write-description --write-auto-subs --write-subs --sub-langs en --convert-subs srt -o "${TEMP_FRAMES_DIR}/../temp_download/%(id)s.%(ext)s" "${url}"`;
			try {
				const tempDir = path.join(__dirname, "temp_download");
				if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
				execSync(mediaCmd, { stdio: "inherit" });

				if (fs.existsSync(tempDir)) {
					for (const file of fs.readdirSync(tempDir)) {
						if (!file.startsWith(ytId)) continue;
						const srcPath = path.join(tempDir, file);
						if (file.endsWith(".mp4") || file.endsWith(".mkv") || file.endsWith(".webm")) {
							fs.renameSync(srcPath, path.join(VIDEOS_DIR, file));
						} else if (file.endsWith(".srt")) {
							fs.renameSync(srcPath, path.join(SUBTITLES_DIR, file));
						} else if (file.endsWith(".description") || file.endsWith(".txt")) {
							fs.renameSync(srcPath, path.join(DESCRIPTIONS_DIR, file));
						} else {
							try {
								fs.unlinkSync(srcPath);
							} catch (e) {}
						}
					}
				}
				console.log(`✅ Media downloaded.`);
			} catch (error) {
				console.error(`❌ Media download failed for ${ytId}.`);
			}
		}

		if (!commentExists) {
			const commentCmd = `yt-dlp --js-runtimes deno --write-comments --skip-download -o "${COMMENTS_DIR}/%(id)s.%(ext)s" "${url}"`;
			try {
				execSync(commentCmd, { stdio: "inherit" });
				console.log(`✅ Comments downloaded.`);
			} catch (error) {
				console.error(`❌ Comment download failed for ${ytId}.`);
			}
		}

		// Metadata extraction
		const infoPath = path.join(COMMENTS_DIR, `${ytId}.info.json`);
		if (fs.existsSync(infoPath)) {
			try {
				const data = JSON.parse(fs.readFileSync(infoPath, "utf8"));
				const title = data.title || "";
				let description = data.description || "";
				const descPath = path.join(DESCRIPTIONS_DIR, `${ytId}.description`);
				if (fs.existsSync(descPath)) description = fs.readFileSync(descPath, "utf8").trim();
				if (description.length > 300) description = description.slice(0, 300);

				const row = [
					csvEscape(ytId),
					csvEscape(url),
					csvEscape(title),
					formatUploadDate(data.upload_date),
					new Date().toISOString().split("T")[0],
					data.view_count || 0,
					data.like_count || 0,
					data.comment_count || (data.comments ? data.comments.length : 0),
					csvEscape(data.channel || data.uploader || ""),
					data.channel_follower_count || 0,
					data.channel_is_verified || false,
					data.language || "",
					csvEscape((data.categories && data.categories[0]) || ""),
					data.duration_string || "",
					csvEscape(description),
				].join(",");
				fs.appendFileSync(VIDEO_MAP, row + "\n");
				console.log(`📋 Added to videoMap.csv: ${ytId} — ${title}`);
			} catch (e) {}
		}
	}
}

async function processAllVideos(freshMode) {
	// First ensure all URLs from YouTubeURLs.txt are downloaded
	ensureDownloads();

	if (!fs.existsSync(VIDEOS_DIR)) {
		console.error(`❌ Videos directory not found at ${VIDEOS_DIR}`);
		return;
	}

	const videoFiles = fs.readdirSync(VIDEOS_DIR).filter((f) => f.endsWith(".mp4") || f.endsWith(".mkv") || f.endsWith(".webm"));

	const scoresMap = freshMode ? new Map() : loadExistingScores();
	const commentIndex = buildCommentIndex();

	saveTracker(videoFiles, commentIndex, scoresMap);

	console.log(`Found ${videoFiles.length} total videos.`);
	console.log(`📂 Comment files indexed: ${commentIndex.size}`);

	for (let i = 0; i < videoFiles.length; i++) {
		const videoFile = videoFiles[i];
		const videoId = path.parse(videoFile).name;

		console.log(`\n======================================================`);
		console.log(`▶️ Processing Video [${i + 1}/${videoFiles.length}]: ${videoId}`);
		console.log(`======================================================`);

		const currentEntry = scoresMap.get(videoId) || {
			videoId,
			scores: null,
			rationale: null,
			expectationFormation: null,
			commentAnalysis: null,
			conflictAnalysis: null,
		};
		scoresMap.set(videoId, currentEntry);

		const videoPath = path.join(VIDEOS_DIR, videoFile);
		const outputDir = path.join(TEMP_FRAMES_DIR, videoId);
		const { srtPath, descPath } = getMediaAssets(videoId);

		// ==========================================
		// PHASE 1: PROCESS VIDEO (IC)
		// ==========================================
		if (!freshMode && currentEntry.scores != null) {
			console.log(`   ⏩ Phase 1 (Video): Already processed.`);
		} else {
			console.log(`   🎬 Phase 1 (Video): Scoring Aesthetics (IC)...`);
			if (srtPath) console.log(`      ➔ Transcript: ${path.basename(srtPath)}`);
			if (descPath) console.log(`      ➔ Description: ${path.basename(descPath)}`);
			try {
				let frames = [];
				const tempDir = path.join(TEMP_FRAMES_DIR, videoId);
				const framesExist = fs.existsSync(tempDir) && fs.readdirSync(tempDir).some((f) => f.endsWith(".jpg") || f.endsWith(".jpeg"));

				if (!framesExist) {
					console.log(`      ➔ Extracting frames...`);
					frames = await extractFrames(videoPath, outputDir);
				} else {
					console.log(`      ⏩ Frames already exist — skipping extraction`);
					frames = fs
						.readdirSync(tempDir)
						.filter((f) => f.endsWith(".jpg") || f.endsWith(".jpeg"))
						.map((f) => path.join(tempDir, f));
				}

				if (frames.length > 0) {
					const icResult = await scoreVideoAesthetics(frames, srtPath, descPath, videoId);
					if (icResult) {
						currentEntry.scores = icResult.scores;
						currentEntry.rationale = icResult.rationale;
						saveScores(scoresMap);
						saveTracker(videoFiles, commentIndex, scoresMap);
						console.log(`   ✅ Phase 1 complete.`);
					}
				} else {
					console.warn(`   ⚠️ No frames available for scoring ${videoId}`);
				}
			} catch (err) {
				console.error(`   ❌ Phase 1 failed:`, err.message);
			}
		}

		// ==========================================
		// PHASE 2: EXPECTATION FORMATION (EF)
		// ==========================================
		if (!freshMode && currentEntry.expectationFormation != null) {
			console.log(`   ⏩ Phase 2 (EF): Already processed.`);
		} else {
			console.log(`   📋 Phase 2 (EF): Scoring Expectation Formation...`);
			try {
				const efResult = await scoreExpectationFormation(videoId, srtPath, descPath, currentEntry.scores);
				if (efResult && efResult.expectationFormation) {
					currentEntry.expectationFormation = efResult.expectationFormation;
					saveScores(scoresMap);
					saveTracker(videoFiles, commentIndex, scoresMap);
					console.log(`   ✅ Phase 2 complete.`);
				}
			} catch (err) {
				console.error(`   ❌ Phase 2 failed:`, err.message);
			}
		}

		// ==========================================
		// PHASE 3: COMMENT ANALYSIS (DC/CA)
		// ==========================================
		if (!freshMode && currentEntry.commentAnalysis != null) {
			console.log(`   ⏩ Phase 3 (Comments): Already processed.`);
		} else {
			console.log(`   💬 Phase 3 (Comments): Analyzing Discourse...`);
			const commentFilePath = commentIndex.get(videoId);
			if (commentFilePath) {
				console.log(`      ➔ Comment file: ${path.basename(commentFilePath)}`);
				try {
					const parsed = parseComments(commentFilePath);
					if (parsed && parsed.parsedComments.length > 0) {
						const chunks = chunkComments(parsed.parsedComments, 500);
						console.log(`      📦 ${parsed.analyzedCount} comments → ${chunks.length} chunk(s)`);

						const chunkResults = [];
						for (let c = 0; c < chunks.length; c++) {
							console.log(`      📦 Chunk ${c + 1}/${chunks.length} (${chunks[c].length} comments)`);
							const formatted = formatCommentsForPrompt(chunks[c]);
							const result = await scoreComments(formatted, currentEntry.scores, videoId, parsed.title, parsed.totalComments, chunks[c].length);
							if (result) chunkResults.push(result);
						}

						if (chunkResults.length > 0) {
							const commentResult = await aggregateChunkResults(chunkResults, videoId, parsed.analyzedCount);
							if (commentResult && commentResult.commentAnalysis) {
								currentEntry.commentAnalysis = commentResult.commentAnalysis;
								saveScores(scoresMap);
								saveTracker(videoFiles, commentIndex, scoresMap);
								console.log(`   ✅ Phase 3 complete.`);
							}
						}
					} else {
						console.log(`      ⚠️ No usable comments found for ${videoId}`);
					}
				} catch (err) {
					console.error(`   ❌ Phase 3 failed:`, err.message);
				}
			} else {
				console.log(`   ⚠️ No comment file found.`);
			}
		}

		// ==========================================
		// PHASE 4: CONFLICT MERGER (Final Analysis)
		// ==========================================
		if (!freshMode && currentEntry.conflictAnalysis != null) {
			console.log(`   ⏩ Phase 4 (Merger): Already processed.`);
		} else if (currentEntry.scores && currentEntry.commentAnalysis) {
			console.log(`   🧠 Phase 4 (Merger): Synthesizing Final Analysis...`);
			try {
				const conflictData = await analyzeConflict(currentEntry);
				if (conflictData) {
					currentEntry.conflictAnalysis = conflictData;
					saveScores(scoresMap);
					saveTracker(videoFiles, commentIndex, scoresMap);
					console.log(`   ✅ Phase 4 complete. (Intensity: ${conflictData.conflictIntensity})`);
				}
			} catch (err) {
				console.error(`   ❌ Phase 4 failed:`, err.message);
			}
		} else {
			console.log(`   ⚠️ Skipping Phase 4. Missing required data (IC or Comments).`);
		}
	}

	console.log(`\n✅ All videos processed successfully!`);
}

const readline = require("readline");

function askQuestion(query) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(query, (ans) => {
			rl.close();
			resolve(ans);
		});
	});
}

async function run() {
	console.log("\n=== RIDE Scorer Pipeline ===");

	const startAnswer = await askQuestion("Do you want to continue processing from last point or start fresh? (continue/fresh) [default: continue]: ");
	const startChoice = startAnswer.trim().toLowerCase();
	const freshMode = startChoice === "fresh" || startChoice === "f";

	if (freshMode) {
		console.log("\n🧹 Starting fresh. Clearing existing dataset files...");
		if (fs.existsSync(OUTPUT_FILE)) {
			try {
				fs.unlinkSync(OUTPUT_FILE);
			} catch (e) {
				/* ignore */
			}
		}
		if (fs.existsSync(CSV_OUTPUT_FILE)) {
			try {
				fs.unlinkSync(CSV_OUTPUT_FILE);
			} catch (e) {
				/* ignore */
			}
		}
		if (fs.existsSync(TRACKER_FILE)) {
			try {
				fs.unlinkSync(TRACKER_FILE);
			} catch (e) {
				/* ignore */
			}
		}
	} else {
		console.log("\n⏯️ Continuing from the last point...");
	}

	await processAllVideos(freshMode);
}

run();
