const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const API_URL = process.env.API_URL;
const MODEL_NAME = process.env.MODEL_NAME;

if (!API_URL || !MODEL_NAME) {
	console.error("❌ Missing API_URL or MODEL_NAME in .env file. Please set them before running.");
	process.exit(1);
}

const { logAPIInteraction } = require("./logger");

function cleanTranscript(srtPath) {
	if (!fs.existsSync(srtPath)) return "";
	const rawSrt = fs.readFileSync(srtPath, "utf8");
	return rawSrt
		.replace(/(?:\d+\r?\n)?(?:\d{2}:\d{2}:\d{2},\d{3}\s-->\s\d{2}:\d{2}:\d{2},\d{3}\r?\n)/g, "")
		.replace(/\[.*?\]/g, "")
		.replace(/\r?\n/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function fileToDataUrl(filePath) {
	const base64Data = fs.readFileSync(filePath).toString("base64");
	return `data:image/jpeg;base64,${base64Data}`;
}

const FRAME_DATA_DIR = path.join(__dirname, "frame_data");
if (!fs.existsSync(FRAME_DATA_DIR)) fs.mkdirSync(FRAME_DATA_DIR);

/**
 * Saves individual frame API response to frame_data/{videoId}/ for model comparison.
 */
function saveFrameData(videoId, frameName, caption, responseData) {
	const videoDir = path.join(FRAME_DATA_DIR, videoId);
	if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

	const safeFrameName = frameName.replace(/\.[^.]+$/, ""); // strip extension
	const outPath = path.join(videoDir, `${safeFrameName}.json`);

	const frameRecord = {
		timestamp: new Date().toISOString(),
		videoId,
		frame: frameName,
		model: responseData?.model || "unknown",
		caption,
		usage: responseData?.usage || null,
		finishReason: responseData?.choices?.[0]?.finish_reason || null,
		rawResponse: responseData,
	};

	try {
		fs.writeFileSync(outPath, JSON.stringify(frameRecord, null, 2) + "\n");
	} catch (err) {
		console.error(`   ⚠️ Failed to save frame data for ${frameName}:`, err.message);
	}
}

async function describeSingleFrame(filePath, videoId) {
	const requestBody = {
		model: MODEL_NAME,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Briefly describe the visual aesthetic and setting of this single travel video frame in one sentence. Focus on lighting, scenery, and subjects.",
					},
					{ type: "image_url", image_url: { url: fileToDataUrl(filePath) } },
				],
			},
		],
		temperature: 0.0,
		top_p: 1.0,
		top_k: 1,
		seed: 42,
		max_tokens: 8192,
	};

	const frameName = path.basename(filePath);

	try {
		const response = await axios.post(API_URL, requestBody, {
			headers: { "Content-Type": "application/json" },
			timeout: 0,
		});
		const msg = response.data.choices[0].message;
		const text = (msg.content && msg.content.trim()) || "";
		logAPIInteraction("describeFrame", frameName, requestBody, response.data);

		const caption = text || "Visual data missing for this frame.";

		// Save individual frame data for model comparison
		if (videoId) {
			saveFrameData(videoId, frameName, caption, response.data);
		}

		return caption;
	} catch (error) {
		logAPIInteraction("describeFrame", frameName, requestBody, error);
		console.error(`⚠️ Failed to describe frame:`, error.message);
		return "Visual data missing for this frame.";
	}
}

async function scoreVideoAesthetics(framePaths, srtPath, descPath, videoId) {
	const transcriptText = srtPath ? cleanTranscript(srtPath) : "No transcript available.";
	const descriptionText = descPath && fs.existsSync(descPath) ? fs.readFileSync(descPath, "utf8").trim() : "No description available.";

	// --- STAGE 1 ---
	const sampledFrames = framePaths.filter((_, i) => i % 2 === 0).slice(0, 15);
	console.log(`\n👁️ STAGE 1: Generating visual captions for ${sampledFrames.length} frames...`);
	const visualCaptions = [];

	for (let i = 0; i < sampledFrames.length; i++) {
		process.stdout.write(`   ➔ Captioning frame ${i + 1}/${sampledFrames.length}... `);
		const caption = await describeSingleFrame(sampledFrames[i], videoId);
		visualCaptions.push(`Frame ${i + 1}: ${caption}`);
		console.log("Done.");
	}

	const compiledVisualNarrative = visualCaptions.join("\n");

	// --- STAGE 2 ---
	console.log(`\n🧠 STAGE 2: Synthesizing final RIDE score (Live Stream)...\n`);

	const promptInstructions = `
    You are an expert qualitative researcher analyzing tourism destination imaginaries.
    Analyze the sequential visual descriptions, the video description, and the spoken transcript below.

    Sequential Visual Frames:
    ${compiledVisualNarrative}

    Video Description:
    "${descriptionText}"

    Spoken Transcript:
    "${transcriptText}"

    Task: Score the destination's "Imaginary Construction" on a scale of 0 to 100 (0 = absent, 1-25 = weak, 26-74 = moderate, 75-99 = strong, 100 = dominant/maximum intensity) across these exact dimensions. Use integers between 0 and 100:
    - authenticity: framed as traditional, local, "real," untouched.
    - escape: framed as freedom from ordinary life.
    - transformation: framed as life-changing or identity-changing.
    - hedonic: framed around pleasure, nightlife, excitement.
    - wellness: framed around peace, healing, simplicity.
    - luxury: framed as elite, exclusive, aspirational.

    CRITICAL: You must respond ONLY with a valid JSON object. Do not include any markdown formatting, backticks, or introductory text. Match this schema exactly (filling scores with integers 0-100):
    {
      "videoId": "${videoId}",
      "scores": {
        "authenticity": 0,
        "escape": 0,
        "transformation": 0,
        "hedonic": 0,
        "wellness": 0,
        "luxury": 0
      },
      "rationale": "A brief 2-sentence qualitative summary detailing how the visual and linguistic cues interact."
    }`;

	const requestBody = {
		model: MODEL_NAME,
		messages: [
			{
				role: "system",
				content: "You are an expert qualitative researcher returning ONLY valid JSON. Do NOT return a tool call or function call object. Perform the analysis yourself.",
			},
			{ role: "user", content: promptInstructions }
		],
		temperature: 0.0,
		top_p: 1.0,
		top_k: 1,
		seed: 42,
		max_tokens: 8192,
		stream: false,
		response_format: { type: "json_object" },
	};

	try {
		const response = await axios.post(API_URL, requestBody, {
			headers: { "Content-Type": "application/json" },
			timeout: 0,
		});

		const message = response.data.choices[0]?.message;
		const rawText = message?.content || "";

		console.log(`\n✅ Video analysis complete. Parsing JSON...`);
		logAPIInteraction("scoreVideoAesthetics", videoId, requestBody, response.data);

		const jsonMatch = rawText.match(/\{[\s\S]*\}/);
		if (!jsonMatch) throw new Error("Model did not return JSON. Raw output: " + rawText);

		const resultJson = JSON.parse(jsonMatch[0]);
		return resultJson;
	} catch (error) {
		logAPIInteraction("scoreVideoAesthetics", videoId, requestBody, error);
		console.error(`\n❌ Error synthesizing final score for ${videoId}:\n`, error.message);
		return null;
	}
}

module.exports = { scoreVideoAesthetics };
