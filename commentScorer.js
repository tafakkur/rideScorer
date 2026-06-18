const axios = require("axios");
require("dotenv").config();

const API_URL = process.env.API_URL;
const MODEL_NAME = process.env.MODEL_NAME;

if (!API_URL || !MODEL_NAME) {
	console.error("❌ Missing API_URL or MODEL_NAME in .env file. Please set them before running.");
	process.exit(1);
}
const { logAPIInteraction } = require("./logger");

/**
 * Scores YouTube comments against the RIDE framework's Disconfirmation and
 * Conflict/Adaptation dimensions using a local LLM (LM Studio).
 *
 * @param {string} formattedComments - Pre-formatted comment text block from comment-parser.
 * @param {object} icScores - The video's existing Imaginary Construction scores.
 * @param {string} videoId - The video identifier.
 * @param {string} videoTitle - The video title for context.
 * @param {number} totalComments - Total comment count on the video.
 * @param {number} analyzedCount - Number of comments being analyzed.
 * @returns {object|null} - The comment analysis result, or null on failure.
 */
async function scoreComments(formattedComments, icScores, videoId, videoTitle, totalComments, analyzedCount) {
	// Build the IC context string
	const icContext = icScores
		? `The video's Imaginary Construction scores (0-100 scale) are:
    - Authenticity: ${icScores.authenticity}
    - Escape: ${icScores.escape}
    - Transformation: ${icScores.transformation}
    - Hedonic: ${icScores.hedonic}
    - Wellness: ${icScores.wellness}
    - Luxury: ${icScores.luxury}`
		: "No Imaginary Construction scores are available for this video.";

	const promptInstructions = `
    You are an expert qualitative researcher analyzing YouTube comments on a tourism video
    to identify Disconfirmation and Conflict/Adaptation patterns within the RIDE framework.

    Video Title: "${videoTitle}"
    Total Comments on Video: ${totalComments}
    Comments Being Analyzed: ${analyzedCount} (sorted by engagement/likes)

    ${icContext}

    The RIDE framework posits that digitally circulated destination imaginaries create expectations
    that may collide with lived realities. Your task is to analyze the comment discourse below
    and score the following dimensions on a 0-100 scale (0 = absent, 1-25 = weak, 26-74 = moderate, 75-99 = strong, 100 = dominant/maximum intensity) with integer values:

    DISCONFIRMATION (DC) — Mismatches between the imaginary/expectation and lived reality:
    - dc_hedonic: Complaints about overcrowding, stress, tourist traps, scams, disappointment
      with the physical experience being less enjoyable than expected.
    - dc_normative: Reports of hostility from residents, anti-tourist sentiment, cultural
      disrespect, "tourists ruined this place" rhetoric, social/cultural tension.

    CONFLICT vs. ADAPTATION (CA) — How tensions are processed in the discourse:
    - ca_conflict: Blame language, outrage, polarization, us-vs-them framing,
      calls for bans/restrictions, aggressive rhetoric.
    - ca_adaptation: Compromise language, negotiation, coexistence framing,
      constructive suggestions, empathy across tourist/resident perspectives.

    SENTIMENT:
    - polarity: Overall sentiment — one of "positive", "negative", "mixed", or "neutral".
    - emotionalIntensity: 0-100 scale (0 = not emotionally charged, 100 = highly emotionally charged). Use integers between 0 and 100.

    COMMENTS TO ANALYZE:
    ${formattedComments}

    CRITICAL: Respond ONLY with a valid JSON object. No markdown, no backticks, no introductory text.
    Match this schema exactly (filling scores and emotionalIntensity with integers 0-100):
    {
      "videoId": "${videoId}",
      "commentAnalysis": {
        "commentCount": ${analyzedCount},
        "disconfirmation": {
          "hedonic": 0,
          "normative": 0
        },
        "conflictAdaptation": {
          "conflict": 0,
          "adaptation": 0
        },
        "sentiment": {
          "polarity": "mixed",
          "emotionalIntensity": 0
        },
        "representativeQuotes": {
          "disconfirmation": "Direct quote from a comment that best illustrates disconfirmation, or 'None identified' if absent.",
          "conflict": "Direct quote from a comment that best illustrates conflict, or 'None identified' if absent.",
          "adaptation": "Direct quote from a comment that best illustrates adaptation, or 'None identified' if absent."
        },
        "rationale": "A brief 2-3 sentence qualitative summary explaining how the comment discourse relates to the video's imaginary construction and where expectation-reality gaps emerge."
      }
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

	return await sendCommentRequest(requestBody, videoId, videoTitle, analyzedCount);
}

/**
 * Sends the comment scoring request with retry logic.
 * If the model returns an empty response, retries once.
 */
async function sendCommentRequest(requestBody, videoId, videoTitle, analyzedCount, attempt = 1) {
	try {
		console.log(`\n💬 ${attempt > 1 ? "(Retry) " : ""}Analyzing ${analyzedCount} comments for "${videoTitle}"...`);

		const response = await axios.post(API_URL, requestBody, {
			headers: { "Content-Type": "application/json" },
			timeout: 0,
		});

		const message = response.data.choices[0]?.message;
		const rawText = message?.content || "";

		console.log(`\n✅ Comment analysis complete. Parsing JSON...`);
		logAPIInteraction("scoreComments", `${videoId}_chunk_${attempt}`, requestBody, response.data);

		const jsonMatch = rawText.match(/\{[\s\S]*\}/);

		if (!jsonMatch) {
			// Retry once if the model returned empty
			if (attempt === 1) {
				console.warn(`\n⚠️ Empty response from model. Retrying with shorter context...`);
				return await sendCommentRequest(requestBody, videoId, videoTitle, analyzedCount, 2);
			}
			throw new Error("Model did not return valid JSON after retry. Raw output: " + rawText);
		}

		const resultJson = JSON.parse(jsonMatch[0]);

		// Normalize emotional_intensity → emotionalIntensity if the model used snake_case
		if (resultJson.commentAnalysis?.sentiment) {
			const s = resultJson.commentAnalysis.sentiment;
			if (s.emotional_intensity !== undefined && s.emotionalIntensity === undefined) {
				s.emotionalIntensity = s.emotional_intensity;
				delete s.emotional_intensity;
			}
		}

		return resultJson;
	} catch (error) {
		logAPIInteraction("scoreComments", `${videoId}_chunk_${attempt}`, requestBody, error);
		console.error(`\n❌ Error analyzing comments for ${videoId}:\n`, error.message);
		return null;
	}
}

/**
 * Sends combined chunk rationales to the LLM for synthesis into a single concise summary.
 *
 * @param {string[]} blockRationales - Array of rationale strings from each chunk.
 * @param {string} videoId - The video identifier.
 * @param {object} aggregatedScores - The averaged scores for context.
 * @returns {string} - A concise 2-4 sentence synthesized rationale.
 */
async function synthesizeRationale(blockRationales, videoId, aggregatedScores) {
	const combinedText = blockRationales
		.map((r, i) => `[Block ${i + 1}] ${r}`)
		.join("\n");

	const prompt = `
You are synthesizing comment analysis results from ${blockRationales.length} chunks of YouTube comments for video ${videoId}.

The aggregated scores across all chunks are:
- Disconfirmation (Hedonic): ${aggregatedScores.dcHedonic}/100
- Disconfirmation (Normative): ${aggregatedScores.dcNormative}/100
- Conflict: ${aggregatedScores.caConflict}/100
- Adaptation: ${aggregatedScores.caAdaptation}/100
- Sentiment: ${aggregatedScores.polarity}, intensity ${aggregatedScores.emotionalIntensity}/100

Here are the individual chunk rationales:
${combinedText}

Write a SINGLE concise rationale (2-4 sentences MAX) that synthesizes the key findings across ALL chunks.
Focus on: the dominant patterns, the most notable tensions, and the overall trajectory of the discourse.
Do NOT list each block. Synthesize into one cohesive summary.

Respond with ONLY the rationale text, no JSON, no labels, no prefixes.`;

	try {
		const response = await axios.post(
			API_URL,
			{
				model: MODEL_NAME,
				messages: [
					{
						role: "system",
						content: "You are an expert qualitative researcher. Return ONLY the plain text summary. Do NOT return JSON or tool calls."
					},
					{ role: "user", content: prompt }
				],
				temperature: 0.0,
				top_p: 1.0,
				top_k: 1,
				seed: 42,
				max_tokens: 8192,
				stream: false,
			},
			{
				headers: { "Content-Type": "application/json" },
				timeout: 0,
			}
		);

		const message = response.data.choices[0]?.message;
		const rawText = (message?.content || "").trim();
		logAPIInteraction("synthesizeRationale", videoId, { chunksCount: blockRationales.length }, response.data);

		if (rawText && rawText.length > 10) {
			console.log(`   ✅ Rationale synthesized (${rawText.length} chars from ${combinedText.length} chars)`);
			return rawText;
		}
	} catch (error) {
		logAPIInteraction("synthesizeRationale", videoId, {}, error);
		console.warn(`   ⚠️ Rationale synthesis failed, falling back to best-chunk rationale`);
	}

	// Fallback: return rationale from first block
	return blockRationales[0] || "No rationale available.";
}

/**
 * Aggregates multiple chunk-level comment analysis results into one combined result.
 * - Numeric scores: averaged and rounded to nearest integer
 * - Sentiment polarity: majority vote
 * - Representative quotes: kept from chunk with highest disconfirmation score
 * - Rationale: synthesized into a concise summary via LLM
 *
 * @param {object[]} chunkResults - Array of scoreComments() results (non-null).
 * @param {string} videoId - The video identifier.
 * @param {number} totalAnalyzed - Total comments across all chunks.
 * @returns {object} - Combined commentAnalysis object.
 */
async function aggregateChunkResults(chunkResults, videoId, totalAnalyzed) {
	const analyses = chunkResults.map((r) => r?.commentAnalysis).filter((a) => a);

	if (analyses.length === 0) return null;
	if (analyses.length === 1) {
		analyses[0].commentCount = totalAnalyzed;
		return { videoId, commentAnalysis: analyses[0] };
	}

	// Average numeric scores
	const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);

	const dcHedonic = avg(analyses.map((a) => a.disconfirmation?.hedonic || 0));
	const dcNormative = avg(analyses.map((a) => a.disconfirmation?.normative || 0));
	const caConflict = avg(analyses.map((a) => a.conflictAdaptation?.conflict || 0));
	const caAdaptation = avg(analyses.map((a) => a.conflictAdaptation?.adaptation || 0));
	const emotionalIntensity = avg(analyses.map((a) => a.sentiment?.emotionalIntensity || a.sentiment?.emotional_intensity || 0));

	// Sentiment polarity: majority vote
	const polarityCounts = {};
	for (const a of analyses) {
		const p = a.sentiment?.polarity || "mixed";
		polarityCounts[p] = (polarityCounts[p] || 0) + 1;
	}
	const polarity = Object.entries(polarityCounts).sort((a, b) => b[1] - a[1])[0][0];

	// Quotes: pick from chunk with highest combined DC score
	const bestChunk = analyses.reduce((best, a) => {
		const score = (a.disconfirmation?.hedonic || 0) + (a.disconfirmation?.normative || 0);
		const bestScore = (best.disconfirmation?.hedonic || 0) + (best.disconfirmation?.normative || 0);
		return score > bestScore ? a : best;
	});

	// Rationale: synthesize all chunk rationales into a concise summary
	const blockRationales = analyses.map((a) => a.rationale || "No rationale.");
	const rationale = await synthesizeRationale(blockRationales, videoId, {
		dcHedonic,
		dcNormative,
		caConflict,
		caAdaptation,
		polarity,
		emotionalIntensity,
	});

	return {
		videoId,
		commentAnalysis: {
			commentCount: totalAnalyzed,
			chunksProcessed: analyses.length,
			disconfirmation: { hedonic: dcHedonic, normative: dcNormative },
			conflictAdaptation: { conflict: caConflict, adaptation: caAdaptation },
			sentiment: { polarity, emotionalIntensity },
			representativeQuotes: bestChunk.representativeQuotes || {},
			rationale,
		},
	};
}

module.exports = { scoreComments, aggregateChunkResults };

