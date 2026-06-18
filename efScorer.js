const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm");

/**
 * Cleans an SRT file by removing timestamps, line numbers, and audio tags.
 * @param {string} srtPath - Path to the .srt file.
 * @returns {string} - Cleaned transcript text.
 */
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

/**
 * Scores the Expectation Formation (EF) dimension of the RIDE framework.
 *
 * EF captures what specific expectations a video communicates to viewers —
 * not whether those expectations are true, but whether the video encourages
 * viewers to anticipate particular experiences or social conditions.
 *
 * Primary signals: spoken transcript + video description.
 * Secondary context: IC scores (if available) to ground the analysis.
 *
 * @param {string} videoId - The video identifier.
 * @param {string|null} srtPath - Path to the subtitle file.
 * @param {string|null} descPath - Path to the description text file.
 * @param {object|null} icScores - The video's Imaginary Construction scores (optional context).
 * @returns {object|null} - The EF scores object, or null on failure.
 */
async function scoreExpectationFormation(videoId, srtPath, descPath, icScores) {
	const transcriptText = srtPath ? cleanTranscript(srtPath) : "No transcript available.";
	const descriptionText = descPath && fs.existsSync(descPath) ? fs.readFileSync(descPath, "utf8").trim() : "No description available.";

	// Build IC context string if scores are available
	const icContext = icScores
		? `For context, the video's Imaginary Construction (IC) scores (0-100) are:
    - Authenticity: ${icScores.authenticity}
    - Escape: ${icScores.escape}
    - Transformation: ${icScores.transformation}
    - Hedonic: ${icScores.hedonic}
    - Wellness: ${icScores.wellness}
    - Luxury: ${icScores.luxury}`
		: "No Imaginary Construction scores are available for context.";

	const promptInstructions = `
    You are an expert qualitative researcher analyzing tourism videos within the RIDE framework.
    Your task is to score the "Expectation Formation" (EF) dimension.

    EF captures what SPECIFIC EXPECTATIONS the video communicates to viewers about the destination experience.
    This is NOT about visual aesthetics (that is Imaginary Construction). This is about what the video
    TELLS or IMPLIES viewers should expect when they visit — promises, claims, and anticipatory framing.

    ${icContext}

    Video Description:
    "${descriptionText}"

    Spoken Transcript:
    "${transcriptText}"

    Score each expectation type on a 0-100 scale (0 = absent, 1-25 = weak, 26-74 = moderate, 75-99 = strong, 100 = dominant).
    Use integers between 0 and 100.

    EXPECTATION TYPES:
    - friendlyLocals: Does the video set expectations that locals are welcoming, friendly, hospitable, warm, helpful?
      Look for: "the people are so nice," "locals love tourists," "everyone is friendly," warm interactions shown.
    - peacefulAtmosphere: Does the video set expectations of calm, quiet, uncrowded, serene, relaxing conditions?
      Look for: "so peaceful," "quiet paradise," "escape the noise," "tranquil," emphasis on silence, stillness, empty beaches.
    - affordability: Does the video set expectations that the destination is cheap, budget-friendly, or great value?
      Look for: prices mentioned, "so affordable," "cheap paradise," "$X per day," cost comparisons, budget tips, "good value."
    - authenticity: Does the video set expectations of genuine, traditional, unspoiled, untouched cultural experiences?
      Look for: "the real [place]," "authentic," "traditional," "hidden gem," "off the beaten path," "local culture."
    - excitement: Does the video set expectations of thrilling, adventurous, high-energy, bustling experiences?
      Look for: "must-do," "bucket list," "incredible," "amazing nightlife," "adventure," "bustling," excitement emphasis.
    - freedom: Does the video set expectations of personal freedom, digital nomad life, flexibility, or escaping the rat race?
      Look for: "digital nomad," "work from anywhere," "freedom," "no 9-to-5," "live on your own terms," "escape the rat race."
    - safety: Does the video set expectations that the destination is safe, secure, low-crime, or walkable?
      Look for: "so safe," "walkable," "no crime," "safe for solo travelers," "felt safe," security reassurances.
    - community: Does the video set expectations of easy social connections, expat/nomad networks, or finding a tribe?
      Look for: "easy to make friends," "expat community," "nomad network," "coworking," "like-minded people," "community."
    - simplicity: Does the video set expectations of slow living, easy logistics, minimal hassle, or uncomplicated life?
      Look for: "slow life," "simple living," "easy to get around," "no stress," "laid back," "hassle-free."
    - transformation: Does the video set expectations of personal growth, finding oneself, spiritual awakening, or life change?
      Look for: "changed my life," "found myself," "spiritual," "yoga retreat," "self-discovery," "transformative."

    CRITICAL: You must respond ONLY with a valid JSON object. No markdown, no backticks, no introductory text.
    Match this schema exactly (filling scores with integers 0-100):
    {
      "videoId": "${videoId}",
      "qualitative_reasoning": "Write a detailed, step-by-step chain of thought here analyzing how the video constructs each of the specific expectation dimensions.",
      "expectationFormation": {
        "friendlyLocals": 0,
        "peacefulAtmosphere": 0,
        "affordability": 0,
        "authenticity": 0,
        "excitement": 0,
        "freedom": 0,
        "safety": 0,
        "community": 0,
        "simplicity": 0,
        "transformation": 0,
        "rationale": "A brief 2-3 sentence summary explaining which expectations are most strongly communicated and how."
      }
    }`;

	const systemPrompt =
		"You are an expert qualitative researcher returning ONLY valid JSON. Do NOT return a tool call or function call object. Perform the analysis yourself.";
	return await sendEFRequest(systemPrompt, promptInstructions, videoId, 1);
}

/**
 * Sends the EF scoring request with retry logic.
 */
async function sendEFRequest(systemPrompt, userPrompt, videoId, attempt) {
	console.log(`\n📋 ${attempt > 1 ? "(Retry) " : ""}Scoring Expectation Formation for ${videoId}...`);

	const result = await callLLM("scoreExpectationFormation", videoId, systemPrompt, userPrompt, true);

	if (result) {
		console.log(`\n✅ EF analysis complete.`);
		return result.expectationFormation;
	}

	if (attempt < 3) {
		console.log(`   ⏳ Retrying in 2 seconds (Attempt ${attempt + 1}/3)...`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
		return await sendEFRequest(systemPrompt, userPrompt, videoId, attempt + 1);
	} else {
		console.error(`\n❌ Failed EF analysis for ${videoId} after 3 attempts.`);
		return null;
	}
}

module.exports = { scoreExpectationFormation };
