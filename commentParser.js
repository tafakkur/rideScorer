const fs = require("fs");
const path = require("path");

const COMMENTS_DIR = path.join(__dirname, "comments");

/**
 * Loads a single .info.json file and extracts the comments array + video metadata.
 * @param {string} filePath - Absolute path to the .info.json file.
 * @returns {{ videoId: string, title: string, comments: object[] } | null}
 */
function loadCommentFile(filePath) {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const data = JSON.parse(raw);

		if (!data.comments || !Array.isArray(data.comments)) {
			console.warn(`⚠️ No comments array found in ${path.basename(filePath)}`);
			return null;
		}

		return {
			videoId: data.id,
			title: data.title,
			commentCount: data.comment_count || data.comments.length,
			comments: data.comments,
		};
	} catch (error) {
		console.error(`❌ Failed to parse ${path.basename(filePath)}:`, error.message);
		return null;
	}
}

/**
 * Parses and ranks comments from a .info.json file.
 * Sorts by like_count descending, takes the top N, and returns clean objects.
 *
 * @param {string} filePath - Path to the .info.json file.
 * @returns {{ videoId: string, title: string, totalComments: number, parsedComments: object[] } | null}
 */
function parseComments(filePath) {
	const data = loadCommentFile(filePath);
	if (!data) return null;

	// Sort by like_count descending, use all comments
	const ranked = data.comments
		.filter((c) => c.text && c.text.trim().length > 0)
		.sort((a, b) => (b.like_count || 0) - (a.like_count || 0));

	const parsedComments = ranked.map((c) => ({
		text: c.text.trim(),
		likeCount: c.like_count || 0,
		author: c.author || "Unknown",
		isReply: c.parent !== "root",
		isUploader: c.author_is_uploader || false,
		timestamp: c.timestamp || null,
	}));

	const limitedComments = parsedComments;

	return {
		videoId: data.videoId,
		title: data.title,
		totalComments: data.commentCount,
		analyzedCount: limitedComments.length,
		parsedComments: limitedComments,
	};
}

/**
 * Builds a lookup map of YouTube video ID → .info.json file path
 * by reading the `id` field from each comment file.
 * @returns {Map<string, string>} - Map of videoId → absolute file path.
 */
function buildCommentIndex() {
	const index = new Map();

	if (!fs.existsSync(COMMENTS_DIR)) {
		console.warn("⚠️ Comments directory not found.");
		return index;
	}

	const files = fs.readdirSync(COMMENTS_DIR).filter((f) => f.endsWith(".info.json"));

	for (const file of files) {
		const filePath = path.join(COMMENTS_DIR, file);
		try {
			const raw = fs.readFileSync(filePath, "utf8");
			const data = JSON.parse(raw);
			if (data.id) {
				index.set(data.id, filePath);
			}
		} catch (e) {
			console.warn(`⚠️ Skipping ${file}: ${e.message}`);
		}
	}

	return index;
}

/**
 * Formats parsed comments into a single text block for LLM consumption.
 * @param {object[]} parsedComments - Array from parseComments().
 * @returns {string} - Formatted comment block.
 */
function formatCommentsForPrompt(parsedComments) {
	return parsedComments
		.map((c, i) => {
			const meta = [];
			if (c.likeCount > 0) meta.push(`${c.likeCount} likes`);
			if (c.isReply) meta.push("reply");
			if (c.isUploader) meta.push("uploader");
			const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : "";
			return `[Comment ${i + 1}]${metaStr}: ${c.text}`;
		})
		.join("\n\n");
}

/**
 * Splits parsed comments into chunks of a given size.
 * @param {object[]} parsedComments - Full array from parseComments().
 * @param {number} [chunkSize=25] - Max comments per chunk.
 * @returns {object[][]} - Array of comment arrays.
 */
function chunkComments(parsedComments, chunkSize = 25) {
	const chunks = [];
	for (let i = 0; i < parsedComments.length; i += chunkSize) {
		chunks.push(parsedComments.slice(i, i + chunkSize));
	}
	return chunks;
}

module.exports = { parseComments, buildCommentIndex, formatCommentsForPrompt, chunkComments };

// --- Standalone test ---
if (require.main === module) {
	const index = buildCommentIndex();
	console.log(`\n📂 Found ${index.size} comment files:\n`);

	for (const [id, filePath] of index) {
		const result = parseComments(filePath);
		if (result) {
			console.log(`  🎬 ${result.title}`);
			console.log(`     YouTube ID: ${id}`);
			console.log(`     Total comments: ${result.totalComments}, Parsed: ${result.analyzedCount}`);
			console.log(`     Top comment: "${result.parsedComments[0]?.text.slice(0, 80)}..."`);
			console.log();
		}
	}
}
