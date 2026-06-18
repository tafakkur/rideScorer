const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");

function extractFrames(videoPath, outputDir) {
	return new Promise((resolve, reject) => {
		// SMART RESUME: If frames already exist, skip FFmpeg extraction
		if (fs.existsSync(outputDir)) {
			const existingFiles = fs
				.readdirSync(outputDir)
				.filter((file) => file.endsWith(".jpg"))
				.map((file) => path.join(outputDir, file));

			if (existingFiles.length > 0) {
				console.log(`⏩ Frames already exist. Skipping extraction. Found ${existingFiles.length} frames.`);
				return resolve(existingFiles);
			}
		} else {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		// Get video duration to estimate total frames
		ffmpeg.ffprobe(videoPath, (err, metadata) => {
			const interval = 10; // 1 frame every 10 seconds
			if (err) {
				console.warn("⚠️ ffprobe failed. Proceeding without duration check:", err.message);
				runFFmpeg(videoPath, outputDir, interval, null, resolve, reject);
			} else {
				const duration = metadata.format.duration;
				const totalExpected = duration ? Math.floor(duration / interval) : 0;
				runFFmpeg(videoPath, outputDir, interval, totalExpected, resolve, reject);
			}
		});
	});
}

function runFFmpeg(videoPath, outputDir, interval, totalExpected, resolve, reject) {
	const totalStr = totalExpected ? ` / ${totalExpected}` : "";
	console.log(`🎬 Starting frame extraction...`);

	ffmpeg(videoPath)
		.on("progress", (progress) => {
			const count = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).filter((file) => file.endsWith(".jpg")).length : 0;
			const percentStr = progress.percent ? ` (${Math.round(progress.percent)}%)` : "";
			process.stdout.write(`   ➔ Frames extracted: ${count}${totalStr}${percentStr}\r`);
		})
		.on("error", (err, stdout, stderr) => {
			console.log(""); // newline
			console.error("❌ FFmpeg Error:", err.message);
			reject(err);
		})
		.on("end", () => {
			console.log(""); // newline
			const extractedFiles = fs
				.readdirSync(outputDir)
				.filter((file) => file.endsWith(".jpg"))
				.map((file) => path.join(outputDir, file));

			console.log(`✅ Extraction complete. Saved ${extractedFiles.length} frames.`);
			resolve(extractedFiles);
		})
		// 1 frame every 30 seconds
		.outputOptions(["-vf", `fps=1/${interval}`])
		.save(path.join(outputDir, "frame-%04d.jpg"));
}

module.exports = { extractFrames };
