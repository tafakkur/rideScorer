const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm");

const OUTPUT_FILE = path.join(__dirname, "rideScores.json");
const CSV_OUTPUT_FILE = path.join(__dirname, "rideScores.csv");

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
 * Loads existing scores from rideScores.json
 */
function loadExistingScores() {
	if (!fs.existsSync(OUTPUT_FILE)) {
		console.error("❌ No rideScores.json found! Run index.js first.");
		return [];
	}
	try {
		const raw = fs.readFileSync(OUTPUT_FILE, "utf8").trim();
		return JSON.parse(raw);
	} catch (e) {
		console.error(`❌ Could not parse ${OUTPUT_FILE}: ${e.message}`);
		return [];
	}
}

/**
 * Saves scores back to rideScores.json and rideScores.csv
 */
function saveScores(entries) {
	fs.writeFileSync(OUTPUT_FILE, JSON.stringify(entries, null, 2) + "\n");

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

	const csvRows = entries.map((entry) => {
		const s = entry.scores || {};
		const ef = entry.expectationFormation || {};
		const ca = entry.commentAnalysis || {};
		const dc = ca.disconfirmation || {};
		const co = ca.conflictAdaptation || {};
		const se = ca.sentiment || {};
		const qu = ca.representativeQuotes || {};
		const intensity = se.emotionalIntensity ?? se.emotional_intensity ?? "";
		const conflict = entry.conflictAnalysis || {};

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
			conflict.hasConflict !== undefined ? conflict.hasConflict : "",
			conflict.conflictIntensity ?? "",
			conflict.rationale || "",
		]
			.map(csvEscape)
			.join(",");
	});

	const csvContent = [csvHeaders, ...csvRows].join("\n") + "\n";
	fs.writeFileSync(CSV_OUTPUT_FILE, csvContent);
}

/**
 * Calls LLM to check for RIDE conflict.
 */
async function analyzeConflict(entry) {
	const ic = entry.scores;
	const ca = entry.commentAnalysis;
	const videoId = entry.videoId;

	const promptInstructions = `
    You are an expert qualitative researcher applying the RIDE framework (Destination Imaginaries, Expectation Formation, Disconfirmation, Conflict, Adaptation).

    You have two sets of data for a tourism video.

    1. Imaginary Construction (IC) Scores (The Expectation/Aesthetic):
    - Authenticity: ${ic.authenticity}
    - Escape: ${ic.escape}
    - Transformation: ${ic.transformation}
    - Hedonic: ${ic.hedonic}
    - Wellness: ${ic.wellness}
    - Luxury: ${ic.luxury}
    Video IC Rationale: "${entry.rationale}"

    2. Comment Analysis (The Lived Reality/Reaction):
    - Disconfirmation (Hedonic): ${ca.disconfirmation?.hedonic}
    - Disconfirmation (Normative): ${ca.disconfirmation?.normative}
    - Conflict: ${ca.conflictAdaptation?.conflict}
    - Adaptation: ${ca.conflictAdaptation?.adaptation}
    - Sentiment Polarity: ${ca.sentiment?.polarity}
    Comment Rationale: "${ca.rationale}"

    Task: Merge these two analyses and determine if there is a fundamental "Conflict" between the promoted Imaginary (IC) and the discourse in the comments (Disconfirmation/Conflict).

    CRITICAL: You must respond ONLY with a valid JSON object. Match this schema exactly:
    {
      "videoId": "${videoId}",
      "qualitative_reasoning": "Write a detailed, step-by-step chain of thought here analyzing the tensions and clashes between the imaginary construction and the comment discourse.",
      "conflictAnalysis": {
        "hasConflict": true, // Boolean (true or false)
        "conflictIntensity": 0, // Integer 0-100 showing how severe the clash between imaginary and reality is
        "rationale": "A 2-3 sentence explanation of how the video's imaginary clashes or aligns with the audience discourse."
      }
    }`;

	const systemPrompt =
		"You are an expert qualitative researcher returning ONLY valid JSON. Do NOT return a tool call or function call object. Perform the analysis yourself.";
	console.log(`   ➔ Asking magic brain to merge scores for ${videoId}...`);

	const result = await callLLM("analyzeConflict", videoId, systemPrompt, promptInstructions, true);

	if (result) {
		return result.conflictAnalysis;
	}

	console.error(`   ❌ Failed to analyze conflict for ${videoId}`);
	return null;
}

async function runMerger() {
	console.log("=== PHASE 3: RIDE Framework Conflict Merger ===");

	const entries = loadExistingScores();
	let updated = false;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		console.log(`\n🎬 Checking video [${i + 1}/${entries.length}]: ${entry.videoId}`);

		if (!entry.scores || !entry.commentAnalysis) {
			console.log(`   ⏩ Skipping. Missing video scores or comment analysis.`);
			continue;
		}

		if (entry.conflictAnalysis) {
			console.log(`   ⏩ Skipping. Conflict analysis already done.`);
			continue;
		}

		const conflictData = await analyzeConflict(entry);
		if (conflictData) {
			entry.conflictAnalysis = conflictData;
			saveScores(entries); // Save progressively
			updated = true;
			console.log(`   ✅ Saved conflict intensity: ${conflictData.conflictIntensity}`);
		}
	}

	if (updated) {
		console.log("\n🎉 Phase 3 complete! CSV rock updated.");
	} else {
		console.log("\n✅ Nothing to update.");
	}
}

runMerger();
