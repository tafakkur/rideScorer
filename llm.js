const axios = require("axios");
require("dotenv").config();
const { logAPIInteraction } = require("./logger");

const API_URL = process.env.API_URL || "http://127.0.0.1:1234/v1/chat/completions";
const MODEL_NAME = process.env.MODEL_NAME || "gemma-4-31B-it-Q4_K_M.gguf";

/**
 * Centralized function to call the LLM endpoint and handle deterministic parameters, logging, and JSON parsing.
 *
 * @param {string} actionType - The type of action for logging (e.g., "describeFrame", "scoreVideoAesthetics").
 * @param {string} labelId - The specific video ID or frame name being processed.
 * @param {string} systemPrompt - The system instruction prompt.
 * @param {string} userPrompt - The specific user prompt/task instructions.
 * @param {boolean} expectJson - Whether to force JSON output and parse via regex.
 * @returns {Promise<any>} - Returns the parsed JSON object if expectJson is true, otherwise the raw string. Null on error.
 */
async function callLLM(actionType, labelId, systemPrompt, userPrompt, expectJson = true) {
	const requestBody = {
		model: MODEL_NAME,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
		temperature: 0.0,
		top_p: 1.0,
		top_k: 1,
		seed: 42,
		max_tokens: 8192,
		stream: false,
	};

	if (expectJson) {
		requestBody.response_format = { type: "json_object" };
	}

	try {
		const response = await axios.post(API_URL, requestBody, {
			headers: { "Content-Type": "application/json" },
			timeout: 0,
		});

		const message = response.data.choices[0]?.message;
		const rawText = message?.content || "";

		logAPIInteraction(actionType, labelId, requestBody, response.data);

		if (expectJson) {
			const jsonMatch = rawText.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				throw new Error("No JSON found in output. Output: " + rawText);
			}
			return JSON.parse(jsonMatch[0]);
		}

		return rawText.trim();
	} catch (error) {
		logAPIInteraction(actionType, labelId, requestBody, error);
		console.error(`❌ [LLM Error - ${actionType}] Failed for ${labelId}: ${error.message}`);
		return null;
	}
}

module.exports = { callLLM };
